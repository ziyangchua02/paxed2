const MAP_CONTAINER_IDS = ["auth-map", "workspace-map"];
const VEHICLE_REFRESH_INTERVAL_MS = 10_000;
const STOP_ARRIVAL_CACHE_TTL_MS = 12_000;
const INITIAL_CENTER = [1.3483, 103.6831];
const INITIAL_ZOOM = 14.7;
const MAX_HEADING_MATCH_DISTANCE_METERS = 220;
const MIN_HEADING_MOVEMENT_METERS = 6;
const USER_LOCATION_MAX_AGE_MS = 60_000;
const USER_LOCATION_TIMEOUT_MS = 9_000;

let map = null;
let routeLayerGroup = null;
let stopLayerGroup = null;
let vehicleLayerGroup = null;
let vehicleMarkers = new Map();
let refreshTimerId = 0;
let isVehicleLoopActive = false;
let routeDataset = null;
let latestVehicles = [];
let visibleServices = new Set();
let hasInitializedServiceVisibility = false;
let previousVehicleSnapshots = [];
const stopArrivalCache = new Map();
let nearestStopsUpdateTimerId = 0;
let nearestStopsRenderSequence = 0;
let userLocationLayerGroup = null;
let userLocationMarker = null;
let userLocation = null;
let hasCenteredOnUserLocation = false;

const servicePanelElement = document.querySelector("#workspace-services");
const serviceFilterListElement = document.querySelector("#service-filter-list");
const showAllServicesButton = document.querySelector("#services-show-all");
const hideAllServicesButton = document.querySelector("#services-hide-all");
const nearestStopsSectionElement = document.querySelector("#workspace-nearest");
const nearestStopsListElement = document.querySelector("#workspace-nearest-list");
const nearestStopsEyebrowElement = nearestStopsSectionElement?.querySelector(
  ".workspace-nearest__eyebrow"
);

const waitForLeaflet = (timeoutMs = 10_000) => {
  if (window.L) {
    return Promise.resolve(window.L);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const intervalId = window.setInterval(() => {
      if (window.L) {
        window.clearInterval(intervalId);
        resolve(window.L);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(intervalId);
        reject(new Error("Leaflet could not be loaded. Please refresh the page."));
      }
    }, 50);
  });
};

const fetchJson = async (url) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
};

const createVehicleIcon = (vehicle) => {
  const label = String(vehicle.serviceNo || "?");
  const heading = Number.isFinite(vehicle?.displayBearing)
    ? normalizeBearing(vehicle.displayBearing).toFixed(1)
    : "0";
  const headingStateClass = Number.isFinite(vehicle?.displayBearing)
    ? " map-vehicle-pin--has-direction"
    : "";
  const serviceToneClass = getServiceToneClass(vehicle?.serviceNo);

  return window.L.divIcon({
    className: "",
    html: `
      <span class="map-vehicle-pin ${serviceToneClass}${headingStateClass}">
        <span class="map-vehicle-pin__direction" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <g transform="rotate(${heading} 12 12)">
              <path d="M12 4 18.5 18h-13L12 4Z" />
            </g>
          </svg>
        </span>
        <span class="map-vehicle-pin__body">
          <span class="map-vehicle-pin__label">${escapeHtml(label)}</span>
          <span class="map-vehicle-pin__glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="4" y="6.5" width="16" height="10" rx="2.2" />
              <path d="M7.5 9.2h9M8 16.5v1.8M16 16.5v1.8" />
              <circle cx="8.3" cy="14.2" r="1.1" />
              <circle cx="15.7" cy="14.2" r="1.1" />
            </svg>
          </span>
        </span>
      </span>
    `,
    iconSize: [62, 34],
    iconAnchor: [31, 27],
    popupAnchor: [0, -20]
  });
};

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toRadians = (value) => (value * Math.PI) / 180;

const normalizeBearing = (value) => {
  const normalized = Number(value) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const getDistanceMeters = (startLat, startLng, endLat, endLng) => {
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(endLat - startLat);
  const deltaLng = toRadians(endLng - startLng);
  const lat1 = toRadians(startLat);
  const lat2 = toRadians(endLat);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
};

const getBearingBetweenPoints = (startLat, startLng, endLat, endLng) => {
  const lat1 = toRadians(startLat);
  const lat2 = toRadians(endLat);
  const deltaLng = toRadians(endLng - startLng);
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
};

const getAvailableServiceEntries = () => Object.entries(routeDataset?.services || {});

const getServiceMeta = (serviceNo) => routeDataset?.services?.[serviceNo] || null;

const toServiceSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const getServiceToneClass = (serviceNo) => `service-tone--${toServiceSlug(serviceNo)}`;

const isServiceVisible = (serviceNo) => visibleServices.has(String(serviceNo));

const getVisibleServiceNos = (serviceNos = []) => {
  const visible = serviceNos.filter((serviceNo) => isServiceVisible(serviceNo));
  return visible.length ? visible : serviceNos;
};

const setNearestStopsReferenceLabel = (referenceSource) => {
  if (!nearestStopsEyebrowElement) {
    return;
  }

  nearestStopsEyebrowElement.textContent =
    referenceSource === "user-location" ? "Near your location" : "Near map center";
};

const createUserLocationIcon = () =>
  window.L.divIcon({
    className: "",
    html: `
      <span class="map-user-location" aria-hidden="true">
        <span class="map-user-location__dot"></span>
      </span>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

const syncUserLocationMarker = () => {
  if (!window.L || !userLocationLayerGroup || !userLocation) {
    return;
  }

  const latLng = [userLocation.lat, userLocation.lng];

  if (!userLocationMarker) {
    userLocationMarker = window.L.marker(latLng, {
      icon: createUserLocationIcon(),
      keyboard: false,
      zIndexOffset: 1200
    }).addTo(userLocationLayerGroup);
    return;
  }

  userLocationMarker.setLatLng(latLng);
};

const updateUserLocation = (position, { centerMap = false } = {}) => {
  const latitude = Number(position?.coords?.latitude);
  const longitude = Number(position?.coords?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return;
  }

  userLocation = {
    lat: latitude,
    lng: longitude,
    accuracyMeters: Number(position?.coords?.accuracy) || null
  };

  syncUserLocationMarker();

  if (centerMap && map && !hasCenteredOnUserLocation) {
    hasCenteredOnUserLocation = true;
    const currentZoom = Number(map.getZoom()) || INITIAL_ZOOM;
    map.flyTo([latitude, longitude], Math.max(currentZoom, 15), {
      animate: true,
      duration: 0.7
    });
  }

  scheduleNearestStopsPanelRender();
};

const requestUserLocation = () => {
  if (!navigator.geolocation) {
    setNearestStopsReferenceLabel("map-center");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      updateUserLocation(position, {
        centerMap: true
      });
    },
    (error) => {
      console.warn("User location could not be resolved.", error);
      setNearestStopsReferenceLabel("map-center");
    },
    {
      enableHighAccuracy: true,
      maximumAge: USER_LOCATION_MAX_AGE_MS,
      timeout: USER_LOCATION_TIMEOUT_MS
    }
  );
};

const getMapReferenceCenter = () => {
  if (Number.isFinite(userLocation?.lat) && Number.isFinite(userLocation?.lng)) {
    return {
      lat: userLocation.lat,
      lng: userLocation.lng,
      source: "user-location"
    };
  }

  if (map?.getCenter) {
    const center = map.getCenter();

    if (Number.isFinite(center?.lat) && Number.isFinite(center?.lng)) {
      return {
        lat: center.lat,
        lng: center.lng,
        source: "map-center"
      };
    }
  }

  if (Number.isFinite(routeDataset?.center?.lat) && Number.isFinite(routeDataset?.center?.lng)) {
    return {
      lat: routeDataset.center.lat,
      lng: routeDataset.center.lng,
      source: "dataset-center"
    };
  }

  return {
    lat: INITIAL_CENTER[0],
    lng: INITIAL_CENTER[1],
    source: "initial"
  };
};

const getUniqueStopsForService = (serviceNo) => {
  const service = getServiceMeta(serviceNo);
  const uniqueStops = new Map();

  for (const direction of service?.directions || []) {
    for (const stop of direction?.stops || []) {
      if (!stop?.code || !Number.isFinite(stop?.lat) || !Number.isFinite(stop?.lng)) {
        continue;
      }

      if (!uniqueStops.has(stop.code)) {
        uniqueStops.set(stop.code, stop);
      }
    }
  }

  return Array.from(uniqueStops.values());
};

const getNearestStopForService = (serviceNo, referenceCenter) => {
  const stops = getUniqueStopsForService(serviceNo);
  let nearestStop = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const stop of stops) {
    const distance = getDistanceMeters(referenceCenter.lat, referenceCenter.lng, stop.lat, stop.lng);

    if (distance < nearestDistance) {
      nearestStop = stop;
      nearestDistance = distance;
    }
  }

  return nearestStop
    ? {
        ...nearestStop,
        distanceMeters: nearestDistance
      }
    : null;
};

const formatDistanceLabel = (distanceMeters) => {
  if (!Number.isFinite(distanceMeters)) {
    return "Distance unavailable";
  }

  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(1)} km away`;
  }

  return `${Math.round(distanceMeters / 10) * 10} m away`;
};

const createNearestStopTimesMarkup = (arrivals) => {
  const upcoming = Array.isArray(arrivals) ? arrivals.slice(0, 2) : [];

  if (!upcoming.length) {
    return `<p class="workspace-nearest-card__empty">No live estimate right now.</p>`;
  }

  return `
    <div class="workspace-nearest-card__times">
      ${upcoming
        .map(
          (arrival) => `
            <span class="workspace-nearest-card__time-chip">
              ${Math.max(Number(arrival?.minutes) || 0, 0)} min
            </span>
          `
        )
        .join("")}
    </div>
  `;
};

const syncVisibleServices = (dataset) => {
  const serviceNos = Object.keys(dataset?.services || {});

  if (!hasInitializedServiceVisibility) {
    visibleServices = new Set();
    hasInitializedServiceVisibility = true;
    return;
  }

  const previousServices = new Set(visibleServices);
  const knownServices = new Set(serviceNos);
  visibleServices = new Set([...visibleServices].filter((serviceNo) => knownServices.has(serviceNo)));

  serviceNos.forEach((serviceNo) => {
    if (!visibleServices.has(serviceNo) && !previousServices.has(serviceNo)) {
      visibleServices.add(serviceNo);
    }
  });
};

const renderServicePanel = () => {
  if (!servicePanelElement || !serviceFilterListElement || !routeDataset) {
    return;
  }

  const serviceMarkup = getAvailableServiceEntries()
    .map(([serviceNo, service]) => {
      const checked = isServiceVisible(serviceNo) ? " checked" : "";
      const label = escapeHtml(service?.shortLabel || serviceNo);
      const name = escapeHtml(service?.title || service?.operates || serviceNo);
      const serviceToneClass = getServiceToneClass(serviceNo);

      return `
        <label class="workspace-service-toggle">
          <input
            class="workspace-service-toggle__input"
            type="checkbox"
            data-service-no="${escapeHtml(serviceNo)}"${checked}
          />
          <span
            class="workspace-service-toggle__swatch ${serviceToneClass}"
            aria-hidden="true"
          ></span>
          <span class="workspace-service-toggle__meta">
            <span class="workspace-service-toggle__code">${label}</span>
            <span class="workspace-service-toggle__name">${name}</span>
          </span>
        </label>
      `;
    })
    .join("");

  serviceFilterListElement.innerHTML = serviceMarkup;
  servicePanelElement.hidden = false;
};

const renderNearestStopsPanel = async () => {
  if (!nearestStopsSectionElement || !nearestStopsListElement || !routeDataset) {
    return;
  }

  const requestSequence = ++nearestStopsRenderSequence;
  const referenceCenter = getMapReferenceCenter();
  setNearestStopsReferenceLabel(referenceCenter.source);
  const serviceSummaries = getAvailableServiceEntries().map(([serviceNo, service]) => ({
    serviceNo,
    service,
    nearestStop: getNearestStopForService(serviceNo, referenceCenter)
  }));
  const uniqueStopCodes = Array.from(
    new Set(serviceSummaries.map((summary) => summary.nearestStop?.code).filter(Boolean))
  );

  nearestStopsSectionElement.hidden = false;

  if (!uniqueStopCodes.length) {
    nearestStopsListElement.innerHTML = `
      <p class="workspace-nearest__empty">Nearest stops could not be resolved yet.</p>
    `;
    return;
  }

  const stopPayloadEntries = await Promise.all(
    uniqueStopCodes.map(async (stopCode) => [
      stopCode,
      await fetchStopArrivals(stopCode).catch(() => null)
    ])
  );

  if (requestSequence !== nearestStopsRenderSequence) {
    return;
  }

  const stopPayloadLookup = new Map(stopPayloadEntries);
  const markup = serviceSummaries
    .map(({ serviceNo, service, nearestStop }) => {
      const serviceToneClass = getServiceToneClass(serviceNo);
      const shortLabel = escapeHtml(service?.shortLabel || serviceNo);
      const stopName = escapeHtml(nearestStop?.name || "No mapped stop");
      const roadName = escapeHtml(nearestStop?.roadName || "");
      const distanceLabel = nearestStop
        ? formatDistanceLabel(nearestStop.distanceMeters)
        : "No stop nearby";
      const stopPayload = nearestStop ? stopPayloadLookup.get(nearestStop.code) : null;
      const servicePayload = Array.isArray(stopPayload?.services)
        ? stopPayload.services.find((entry) => String(entry?.serviceNo) === String(serviceNo))
        : null;

      return `
        <article class="workspace-nearest-card ${serviceToneClass}" role="listitem">
          <div class="workspace-nearest-card__header">
            <span class="workspace-nearest-card__service ${serviceToneClass}">${shortLabel}</span>
            <span class="workspace-nearest-card__distance">${escapeHtml(distanceLabel)}</span>
          </div>
          <p class="workspace-nearest-card__stop">${stopName}</p>
          <p class="workspace-nearest-card__meta">
            ${roadName || "Nearest stop on this line"}
          </p>
          ${createNearestStopTimesMarkup(servicePayload?.arrivals)}
        </article>
      `;
    })
    .join("");

  nearestStopsListElement.innerHTML = markup;
};

const scheduleNearestStopsPanelRender = (delayMs = 0) => {
  window.clearTimeout(nearestStopsUpdateTimerId);
  nearestStopsUpdateTimerId = window.setTimeout(() => {
    void renderNearestStopsPanel();
  }, delayMs);
};

const getCrowdToneClass = (crowdLevel) => {
  const normalized = String(crowdLevel || "").trim().toLowerCase();

  if (normalized === "low") {
    return "map-popup-card__stat--positive";
  }

  if (normalized === "moderate") {
    return "map-popup-card__stat--warm";
  }

  if (normalized === "high") {
    return "map-popup-card__stat--alert";
  }

  return "";
};

const createCrowdIcons = (crowdLevel) => {
  const normalized = String(crowdLevel || "").trim().toLowerCase();
  const activeCount =
    normalized === "low" ? 1 : normalized === "moderate" ? 2 : normalized === "high" ? 3 : 0;
  const ariaLabel =
    normalized === "low"
      ? "Low crowd"
      : normalized === "moderate"
        ? "Moderate crowd"
        : normalized === "high"
          ? "High crowd"
          : "Crowd unknown";

  return `
    <span class="map-popup-card__crowd-icons" role="img" aria-label="${ariaLabel}">
      ${Array.from({ length: 3 }, (_, index) => {
        const isActive = index < activeCount;
        return `
          <span class="map-popup-card__crowd-icon${isActive ? " is-active" : ""}" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="7.2" r="3.2" />
              <path d="M6.8 18.7c0-2.9 2.34-5.2 5.2-5.2s5.2 2.3 5.2 5.2" />
            </svg>
          </span>
        `;
      }).join("")}
    </span>
  `;
};

const createAccessibilityIcon = (busFeature) => {
  const isAccessible = String(busFeature || "").trim().toUpperCase() === "WAB";
  const ariaLabel = isAccessible ? "Wheelchair accessible" : "Not wheelchair accessible";

  return `
    <span class="map-popup-card__access-icon${isAccessible ? " is-accessible" : " is-inaccessible"}" role="img" aria-label="${ariaLabel}">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="15.5" cy="5.8" r="1.8" />
        <path d="M13.8 8.2h-2.7v4.5h3.1l1.9 3.4" />
        <path d="M11 10.3 8.2 13" />
        <path d="M12.7 18.3a4.3 4.3 0 1 1-1.1-8.5" />
        <path d="M14.3 15.3h4.2" />
        ${isAccessible ? "" : '<path d="M5 5 19 19" />'}
      </svg>
    </span>
  `;
};

const createVehicleStat = ({
  label,
  value,
  valueHtml = "",
  detail = "",
  primary = false,
  className = ""
}) => {
  const primaryClass = primary ? " map-popup-card__stat--primary" : "";
  const toneClass = className ? ` ${className}` : "";
  const renderedValue = valueHtml || escapeHtml(value);

  return `
    <section class="map-popup-card__stat${primaryClass}${toneClass}">
      <span class="map-popup-card__stat-label">${escapeHtml(label)}</span>
      <strong class="map-popup-card__stat-value">${renderedValue}</strong>
      ${detail ? `<span class="map-popup-card__stat-detail">${escapeHtml(detail)}</span>` : ""}
    </section>
  `;
};

const createVehiclePopupContent = (vehicle) => {
  const service = getServiceMeta(vehicle?.serviceNo);
  const serviceToneClass = getServiceToneClass(vehicle?.serviceNo);
  const serviceLabel = escapeHtml(service?.title || `Bus ${vehicle?.serviceNo || "?"}`);
  const serviceShortLabel = escapeHtml(service?.shortLabel || vehicle?.serviceNo || "?");
  const nextStop = vehicle?.nextStopName
    ? escapeHtml(vehicle.nextStopName)
    : "Live position only";
  const nextStopTiming = Number.isFinite(vehicle?.nextStopMinutes)
    ? vehicle.nextStopMinutes === 0
      ? "Arriving"
      : `${Math.max(Number(vehicle.nextStopMinutes) || 0, 0)} min`
    : "Unknown";
  const vehiclePlate = escapeHtml(vehicle?.vehiclePlate || "Unknown");
  const crowdToneClass = getCrowdToneClass(vehicle?.crowdLevel);

  if (vehicle?.isCampusService) {
    return `
      <article class="map-popup-card map-popup-card--vehicle ${serviceToneClass}">
        <div class="map-popup-card__hero">
          <div class="map-popup-card__hero-copy">
            <p class="map-popup-card__eyebrow">Campus</p>
            <h3 class="map-popup-card__title">${serviceLabel}</h3>
          </div>
          <div class="map-popup-card__hero-pills">
            <span class="map-popup-card__pill map-popup-card__pill--route ${serviceToneClass}">
              ${serviceShortLabel}
            </span>
          </div>
        </div>
        <div class="map-popup-card__stats">
          ${createVehicleStat({
            label: "ETA",
            value: nextStopTiming,
            detail: nextStop,
            primary: true
          })}
          ${createVehicleStat({
            label: "Bus plate",
            value: vehiclePlate
          })}
          ${createVehicleStat({
            label: "Crowd",
            valueHtml: createCrowdIcons(vehicle?.crowdLevel),
            className: crowdToneClass
          })}
        </div>
      </article>
    `;
  }

  const serviceMode = escapeHtml(service?.operates || "Live vehicle");
  const accessToneClass =
    String(vehicle?.busFeature || "").trim().toUpperCase() === "WAB"
      ? "map-popup-card__stat--positive"
      : "map-popup-card__stat--alert";

  return `
    <article class="map-popup-card map-popup-card--vehicle ${serviceToneClass}">
      <div class="map-popup-card__hero">
        <div class="map-popup-card__hero-copy">
          <p class="map-popup-card__eyebrow">Public</p>
          <h3 class="map-popup-card__title">${serviceLabel}</h3>
        </div>
        <div class="map-popup-card__hero-pills">
          <span class="map-popup-card__pill map-popup-card__pill--route ${serviceToneClass}">
            ${serviceShortLabel}
          </span>
        </div>
      </div>
      <div class="map-popup-card__stats">
        ${createVehicleStat({
          label: "Next stop",
          value: nextStop,
          primary: true,
          detail: serviceMode
        })}
        ${createVehicleStat({
          label: "Crowd",
          valueHtml: createCrowdIcons(vehicle?.crowdLevel),
          className: crowdToneClass
        })}
        ${createVehicleStat({
          label: "Access",
          valueHtml: createAccessibilityIcon(vehicle?.busFeature),
          className: accessToneClass
        })}
      </div>
    </article>
  `;
};

const createStopPopupLoadingContent = (stop) => `
  <article class="map-stop-sheet">
    <div class="map-stop-sheet__header">
      <div class="map-stop-sheet__title-block">
        <h3 class="map-stop-sheet__title">${escapeHtml(stop?.name || stop?.code || "Bus stop")}</h3>
        <p class="map-stop-sheet__subtitle">${escapeHtml(stop?.roadName || stop?.code || "")}</p>
      </div>
      <div class="map-stop-sheet__chips">
        ${getVisibleServiceNos(stop?.services || [])
          .map((serviceNo) => {
            return `
              <span class="map-stop-sheet__chip ${getServiceToneClass(serviceNo)}">
                ${escapeHtml(getServiceMeta(serviceNo)?.shortLabel || serviceNo)}
              </span>
            `;
          })
          .join("")}
      </div>
    </div>
    <div class="map-stop-sheet__cards">
      <section class="map-stop-sheet__card">
        <p class="map-stop-sheet__message">Loading live arrivals...</p>
      </section>
    </div>
  </article>
`;

const createStopPopupContent = (stop, payload) => {
  const stopMeta = payload?.stop || stop || {};
  const services = Array.isArray(payload?.services) ? payload.services : [];
  const visibleServicesForStop = services.filter((service) => isServiceVisible(service.serviceNo));
  const servicesToRender = visibleServicesForStop.length ? visibleServicesForStop : services;

  const cardsMarkup = servicesToRender
    .map((service) => {
      const minutes = Array.isArray(service?.arrivals) ? service.arrivals.slice(0, 2) : [];
      const label = escapeHtml(service?.shortLabel || service?.serviceNo || "Service");
      const serviceToneClass = getServiceToneClass(service?.serviceNo);
      const liveCells = minutes.length
        ? minutes
            .map(
              (arrival) => `
                <span class="map-stop-sheet__time-chip">${Math.max(Number(arrival.minutes) || 0, 0)} min</span>
              `
            )
            .join("")
        : "";
      const message = "No live estimate is available right now.";

      return `
        <section class="map-stop-sheet__card ${serviceToneClass}">
          <div class="map-stop-sheet__card-header">
            <span class="map-stop-sheet__mini-chip ${serviceToneClass}">${label}</span>
            <span class="map-stop-sheet__card-title">${escapeHtml(service?.title || label)}</span>
          </div>
          ${
            liveCells
              ? `<div class="map-stop-sheet__times">${liveCells}</div>`
              : `<p class="map-stop-sheet__message">${message}</p>`
          }
        </section>
      `;
    })
    .join("");

  const chipsMarkup = servicesToRender
    .map(
      (service) => `
        <span class="map-stop-sheet__chip ${getServiceToneClass(service?.serviceNo)}">
          ${escapeHtml(service?.shortLabel || service?.serviceNo || "Service")}
        </span>
      `
    )
    .join("");

  return `
    <article class="map-stop-sheet">
      <div class="map-stop-sheet__header">
        <div class="map-stop-sheet__title-block">
          <h3 class="map-stop-sheet__title">${escapeHtml(stopMeta?.name || stop?.name || "Bus stop")}</h3>
          <p class="map-stop-sheet__subtitle">${escapeHtml(stopMeta?.roadName || stop?.roadName || stopMeta?.code || stop?.code || "")}</p>
        </div>
        <div class="map-stop-sheet__chips">${chipsMarkup}</div>
      </div>
      <div class="map-stop-sheet__cards">${cardsMarkup}</div>
    </article>
  `;
};

const attachVehicleDirections = (vehicles) => {
  const previousByService = new Map();

  previousVehicleSnapshots.forEach((snapshot, index) => {
    const serviceNo = String(snapshot?.serviceNo || "");

    if (!serviceNo) {
      return;
    }

    const bucket = previousByService.get(serviceNo) || [];
    bucket.push({ ...snapshot, index });
    previousByService.set(serviceNo, bucket);
  });

  const nextSnapshots = [];
  const enrichedVehicles = vehicles.map((vehicle) => {
    const serviceNo = String(vehicle?.serviceNo || "");
    const explicitBearing = Number.isFinite(vehicle?.bearing)
      ? normalizeBearing(vehicle.bearing)
      : null;
    let displayBearing = explicitBearing;

    if (!serviceNo || !Number.isFinite(vehicle?.lat) || !Number.isFinite(vehicle?.lng)) {
      return {
        ...vehicle,
        displayBearing
      };
    }

    if (displayBearing === null) {
      const previousMatches = previousByService.get(serviceNo) || [];
      let bestMatch = null;

      previousMatches.forEach((candidate) => {
        if (candidate.used) {
          return;
        }

        const distance = getDistanceMeters(
          candidate.lat,
          candidate.lng,
          vehicle.lat,
          vehicle.lng
        );

        if (distance > MAX_HEADING_MATCH_DISTANCE_METERS) {
          return;
        }

        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = {
            candidate,
            distance
          };
        }
      });

      if (bestMatch) {
        bestMatch.candidate.used = true;

        if (bestMatch.distance >= MIN_HEADING_MOVEMENT_METERS) {
          displayBearing = getBearingBetweenPoints(
            bestMatch.candidate.lat,
            bestMatch.candidate.lng,
            vehicle.lat,
            vehicle.lng
          );
        } else if (Number.isFinite(bestMatch.candidate.displayBearing)) {
          displayBearing = normalizeBearing(bestMatch.candidate.displayBearing);
        }
      }
    }

    const enrichedVehicle = {
      ...vehicle,
      displayBearing
    };

    nextSnapshots.push({
      serviceNo,
      lat: vehicle.lat,
      lng: vehicle.lng,
      displayBearing
    });

    return enrichedVehicle;
  });

  previousVehicleSnapshots = nextSnapshots;
  return enrichedVehicles;
};

const toSafeHexColor = (value, fallback = "#64748b") => {
  const candidate = String(value || "").trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(candidate)
    ? candidate
    : fallback;
};

const getStopServiceColors = (stop) => {
  const visibleServiceNos = getVisibleServiceNos(stop?.services || []);
  const uniqueColors = [];

  visibleServiceNos.forEach((serviceNo) => {
    const color = toSafeHexColor(getServiceMeta(serviceNo)?.color, "");

    if (color && !uniqueColors.includes(color)) {
      uniqueColors.push(color);
    }
  });

  return (uniqueColors.length ? uniqueColors : ["#64748b"]).slice(0, 3);
};

const polarToCartesian = (centerX, centerY, radius, angleInDegrees) => {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians)
  };
};

const buildSectorPath = (centerX, centerY, radius, startAngle, endAngle) => {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    `M ${centerX} ${centerY}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
    "Z"
  ].join(" ");
};

const createStopMarkerSvg = (colors) => {
  const center = 10;
  const outerRadius = 8.8;
  const innerRadius = 5.1;
  const segmentAngle = 360 / colors.length;

  const segments =
    colors.length === 1
      ? `<circle cx="${center}" cy="${center}" r="${outerRadius}" fill="${colors[0]}" />`
      : colors
          .map((color, index) => {
            const startAngle = -90 + index * segmentAngle;
            const endAngle = startAngle + segmentAngle;

            return `<path d="${buildSectorPath(center, center, outerRadius, startAngle, endAngle)}" fill="${color}" />`;
          })
          .join("");

  return `
    <svg class="map-stop-marker" viewBox="0 0 20 20" aria-hidden="true">
      ${segments}
      <circle
        cx="${center}"
        cy="${center}"
        r="${outerRadius}"
        fill="none"
        stroke="#ffffff"
        stroke-opacity="0.96"
        stroke-width="1.15"
      />
      <circle
        class="map-stop-marker__core"
        cx="${center}"
        cy="${center}"
        r="${innerRadius}"
      />
    </svg>
  `;
};

const createStopIcon = (stop) =>
  window.L.divIcon({
    className: "",
    html: createStopMarkerSvg(getStopServiceColors(stop)),
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

const fetchStopArrivals = async (stopCode) => {
  const cachedEntry = stopArrivalCache.get(stopCode);

  if (cachedEntry?.payload && Date.now() - cachedEntry.fetchedAt < STOP_ARRIVAL_CACHE_TTL_MS) {
    return cachedEntry.payload;
  }

  if (cachedEntry?.promise) {
    return cachedEntry.promise;
  }

  let request = null;
  request = fetchJson(`/api/map/stops/${encodeURIComponent(stopCode)}/arrivals`)
    .then((payload) => {
      stopArrivalCache.set(stopCode, {
        payload,
        fetchedAt: Date.now()
      });
      return payload;
    })
    .catch((error) => {
      const currentEntry = stopArrivalCache.get(stopCode);

      if (currentEntry?.promise === request) {
        stopArrivalCache.delete(stopCode);
      }

      throw error;
    });

  stopArrivalCache.set(stopCode, {
    promise: request,
    fetchedAt: Date.now()
  });
  return request;
};

const drawRoutes = (dataset) => {
  routeLayerGroup.clearLayers();
  stopLayerGroup.clearLayers();

  for (const [serviceNo, service] of Object.entries(dataset.services || {})) {
    if (!isServiceVisible(serviceNo)) {
      continue;
    }

    const serviceColor = service?.color || "#8b5cf6";

    for (const direction of service?.directions || []) {
      const path = Array.isArray(direction?.path) ? direction.path : [];

      if (path.length > 1) {
        window.L.polyline(path, {
          color: "#ffffff",
          weight: 5,
          opacity: 0.88,
          lineCap: "round",
          lineJoin: "round"
        }).addTo(routeLayerGroup);

        window.L.polyline(path, {
          color: serviceColor,
          weight: 3,
          opacity: 0.98,
          lineCap: "round",
          lineJoin: "round"
        })
          .bindTooltip(serviceNo, {
            direction: "top",
            offset: [0, -6],
            opacity: 0.95
          })
          .addTo(routeLayerGroup);
      }
    }
  }

  const validStops = (dataset.stops || []).filter(
    (stop) =>
      Number.isFinite(stop?.lat) &&
      Number.isFinite(stop?.lng) &&
      Array.isArray(stop?.services) &&
      stop.services.some((svc) => isServiceVisible(svc))
  );

  const clusters = [];

  for (const stop of validStops) {
    let mergedCluster = null;

    for (const cluster of clusters) {
      const distance = getDistanceMeters(stop.lat, stop.lng, cluster.lat, cluster.lng);
      if (distance < 25) {
        mergedCluster = cluster;
        break;
      }
    }

    if (mergedCluster) {
      mergedCluster.codes.push(stop.code);
      stop.services.forEach((s) => mergedCluster.serviceSet.add(s));
      if (stop.name && !mergedCluster.names.includes(stop.name)) {
        mergedCluster.names.push(stop.name);
      }
      if (stop.roadName && !mergedCluster.roadNames.includes(stop.roadName)) {
        mergedCluster.roadNames.push(stop.roadName);
      }
    } else {
      clusters.push({
        lat: stop.lat,
        lng: stop.lng,
        codes: [stop.code],
        serviceSet: new Set(stop.services),
        names: stop.name ? [stop.name] : [],
        roadNames: stop.roadName ? [stop.roadName] : [],
        code: stop.code // fallback for tooltip/UI
      });
    }
  }

  for (const cluster of clusters) {
    cluster.services = Array.from(cluster.serviceSet);
    cluster.name = cluster.names.join(" / ") || cluster.codes.join(" / ");
    cluster.roadName = cluster.roadNames.join(" / ") || "";

    const stopMarker = window.L.marker([cluster.lat, cluster.lng], {
      icon: createStopIcon(cluster),
      keyboard: false,
      zIndexOffset: 600
    })
      .bindPopup(createStopPopupLoadingContent(cluster), {
        maxWidth: 440,
        closeButton: false
      })
      .bindTooltip(escapeHtml(cluster.names[0] || cluster.codes[0] || "Stop"), {
        direction: "top",
        offset: [0, -8],
        opacity: 0.94
      });

    stopMarker.on("popupopen", async () => {
      stopMarker.setPopupContent(createStopPopupLoadingContent(cluster));

      try {
        const arrivalFetches = cluster.codes.map((code) =>
          fetchStopArrivals(code).catch((e) => {
            console.error(`Stop arrivals for code ${code} could not be loaded.`, e);
            return null;
          })
        );
        const payloads = await Promise.all(arrivalFetches);

        const combinedServices = [];
        for (const p of payloads) {
          if (p && Array.isArray(p.services)) {
            combinedServices.push(...p.services);
          }
        }

        const combinedPayload = {
          stop: cluster,
          services: combinedServices
        };

        stopMarker.setPopupContent(createStopPopupContent(cluster, combinedPayload));
      } catch (error) {
        console.error("Critical error loading cluster stop arrivals.", error);
        stopMarker.setPopupContent(`
          <article class="map-stop-sheet">
            <div class="map-stop-sheet__header">
              <div class="map-stop-sheet__title-block">
                <h3 class="map-stop-sheet__title">${escapeHtml(cluster.name || "Bus stop")}</h3>
                <p class="map-stop-sheet__subtitle">${escapeHtml(cluster.roadName || "")}</p>
              </div>
            </div>
            <div class="map-stop-sheet__cards">
              <section class="map-stop-sheet__card">
                <p class="map-stop-sheet__message">Live arrivals could not be loaded right now.</p>
              </section>
            </div>
          </article>
        `);
      }
    });

    stopMarker.addTo(stopLayerGroup);
  }
};

const updateVehicleMarkers = (vehicles) => {
  const visibleVehicles = vehicles.filter((vehicle) => isServiceVisible(vehicle?.serviceNo));
  const nextLookup = new Map();

  for (const vehicle of visibleVehicles) {
    if (!Number.isFinite(vehicle?.lat) || !Number.isFinite(vehicle?.lng)) {
      continue;
    }

    const markerId = String(vehicle.id || `${vehicle.serviceNo}:${vehicle.lat}:${vehicle.lng}`);
    const latLng = [vehicle.lat, vehicle.lng];

    let marker = vehicleMarkers.get(markerId);

    if (!marker) {
      marker = window.L.marker(latLng, {
        icon: createVehicleIcon(vehicle),
        keyboard: false,
        zIndexOffset: 800
      })
        .bindPopup(createVehiclePopupContent(vehicle), {
          maxWidth: 260,
          closeButton: false
        })
        .addTo(vehicleLayerGroup);
    } else {
      marker.setLatLng(latLng);
      marker.setIcon(createVehicleIcon(vehicle));
      marker.setPopupContent(createVehiclePopupContent(vehicle));
    }

    nextLookup.set(markerId, marker);
  }

  for (const [markerId, marker] of vehicleMarkers.entries()) {
    if (nextLookup.has(markerId)) {
      continue;
    }

    marker.remove();
  }

  vehicleMarkers = nextLookup;
};

const refreshVehicles = async () => {
  try {
    const payload = await fetchJson("/api/map/vehicles");
    latestVehicles = attachVehicleDirections(
      Array.isArray(payload?.vehicles) ? payload.vehicles : []
    );
    updateVehicleMarkers(latestVehicles);
    scheduleNearestStopsPanelRender();
  } catch (error) {
    console.error("Vehicle refresh failed.", error);
  }
};

const applyVisibleServices = () => {
  if (!routeDataset || !routeLayerGroup || !stopLayerGroup || !vehicleLayerGroup) {
    return;
  }

  drawRoutes(routeDataset);
  updateVehicleMarkers(latestVehicles);
  renderServicePanel();
};

const setupServicePanel = () => {
  if (!serviceFilterListElement) {
    return;
  }

  showAllServicesButton?.addEventListener("click", () => {
    visibleServices = new Set(getAvailableServiceEntries().map(([serviceNo]) => serviceNo));
    applyVisibleServices();
  });

  hideAllServicesButton?.addEventListener("click", () => {
    visibleServices = new Set();
    applyVisibleServices();
  });

  serviceFilterListElement.addEventListener("change", (event) => {
    const input = event.target;

    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") {
      return;
    }

    const serviceNo = input.dataset.serviceNo;

    if (!serviceNo) {
      return;
    }

    if (input.checked) {
      visibleServices.add(serviceNo);
    } else {
      visibleServices.delete(serviceNo);
    }

    applyVisibleServices();
  });
};

const startVehicleLoop = () => {
  if (isVehicleLoopActive) {
    return;
  }

  isVehicleLoopActive = true;

  const scheduleNext = () => {
    if (!isVehicleLoopActive) {
      return;
    }

    refreshTimerId = window.setTimeout(async () => {
      if (!isVehicleLoopActive) {
        return;
      }

      await refreshVehicles();
      scheduleNext();
    }, VEHICLE_REFRESH_INTERVAL_MS);
  };

  void refreshVehicles().then(() => {
    if (!isVehicleLoopActive) {
      return;
    }

    scheduleNext();
  });
};

const stopVehicleLoop = () => {
  isVehicleLoopActive = false;
  window.clearTimeout(refreshTimerId);
};

const resolveMapContainerId = () => {
  for (const containerId of MAP_CONTAINER_IDS) {
    if (document.querySelector(`#${containerId}`)) {
      return containerId;
    }
  }

  return null;
};

const bootstrapMap = async () => {
  const mapContainerId = resolveMapContainerId();

  if (!mapContainerId) {
    return;
  }

  try {
    const L = await waitForLeaflet();
    const dataset = await fetchJson("/api/map/routes");
    routeDataset = dataset;
    syncVisibleServices(dataset);
    const center = dataset?.center;
    const zoom = Number.isFinite(Number(dataset?.zoom)) ? Number(dataset.zoom) : INITIAL_ZOOM;

    map = L.map(mapContainerId, {
      attributionControl: false,
      zoomControl: false,
      preferCanvas: true,
      minZoom: 11
    }).setView(
      Number.isFinite(center?.lat) && Number.isFinite(center?.lng)
        ? [center.lat, center.lng]
        : INITIAL_CENTER,
      zoom
    );

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19
    }).addTo(map);

    routeLayerGroup = L.layerGroup().addTo(map);
    stopLayerGroup = L.layerGroup().addTo(map);
    vehicleLayerGroup = L.layerGroup().addTo(map);
    userLocationLayerGroup = L.layerGroup().addTo(map);

    map.on("moveend", () => {
      scheduleNearestStopsPanelRender(180);
    });

    renderServicePanel();
    drawRoutes(dataset);
    scheduleNearestStopsPanelRender();
    requestUserLocation();
    startVehicleLoop();
  } catch (error) {
    console.error("Map bootstrap failed.", error);
  }
};

const handleWorkspaceViewChange = (event) => {
  const viewName = event?.detail?.viewName;

  if (viewName === "drive") {
    stopVehicleLoop();
    return;
  }

  if (viewName === "buses") {
    startVehicleLoop();

    if (map?.invalidateSize) {
      window.setTimeout(() => {
        map.invalidateSize();
      }, 90);
    }

    scheduleNearestStopsPanelRender(90);
  }
};

setupServicePanel();
window.addEventListener("workspace:viewchange", handleWorkspaceViewChange);
bootstrapMap();

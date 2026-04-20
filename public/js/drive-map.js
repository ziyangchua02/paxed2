const DRIVE_MAP_CONTAINER_ID = "workspace-drive-map";
const DRIVE_SECTION_ID = "workspace-drive";
const DRIVE_LIST_ID = "workspace-drive-list";
const DRIVE_REFERENCE_LABEL_ID = "workspace-drive-eyebrow";
const DRIVE_REFRESH_INTERVAL_MS = 30_000;
const DRIVE_DEFAULT_CENTER = [1.3521, 103.8198];
const DRIVE_DEFAULT_ZOOM = 14.2;
const DRIVE_DEFAULT_RADIUS_METERS = 2_500;
const DRIVE_DEFAULT_LIMIT = 140;
const DRIVE_LIST_LIMIT = 14;
const USER_LOCATION_MAX_AGE_MS = 60_000;
const USER_LOCATION_TIMEOUT_MS = 9_000;

const driveSectionElement = document.querySelector(`#${DRIVE_SECTION_ID}`);
const driveListElement = document.querySelector(`#${DRIVE_LIST_ID}`);
const driveReferenceLabelElement = document.querySelector(`#${DRIVE_REFERENCE_LABEL_ID}`);

let driveMap = null;
let driveCarparkLayerGroup = null;
let driveUserLayerGroup = null;
let driveUserLocationMarker = null;
let driveRefreshTimerId = 0;
let driveRenderSequence = 0;
let driveMapInitialized = false;
let driveHasCenteredOnUserLocation = false;
let driveUserLocation = null;
let driveMarkersByCarparkNo = new Map();
let driveLastSuccessfulState = null;

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
        reject(new Error("Leaflet could not be loaded for drive map."));
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

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toRadians = (value) => (value * Math.PI) / 180;

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

const formatDistanceLabel = (distanceMeters) => {
  if (!Number.isFinite(distanceMeters)) {
    return "Distance unavailable";
  }

  if (distanceMeters >= 1_000) {
    return `${(distanceMeters / 1_000).toFixed(1)} km away`;
  }

  return `${Math.round(distanceMeters / 10) * 10} m away`;
};

const formatUpdatedLabel = (isoDateTime) => {
  if (!isoDateTime) {
    return "Live lot data unavailable right now.";
  }

  const timestampMs = new Date(isoDateTime).getTime();

  if (!Number.isFinite(timestampMs)) {
    return "Live lot data unavailable right now.";
  }

  const elapsedMinutes = Math.max(Math.round((Date.now() - timestampMs) / 60_000), 0);

  if (elapsedMinutes < 1) {
    return "Updated just now.";
  }

  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes} min ago.`;
  }

  return `Updated at ${new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })}.`;
};

const getAvailabilityTone = (availability) => {
  const totalLots = Number(availability?.totalLots);
  const availableLots = Number(availability?.availableLots);

  if (!Number.isFinite(totalLots) || totalLots <= 0 || !Number.isFinite(availableLots)) {
    return {
      className: "is-unknown",
      color: "#64748b"
    };
  }

  const ratio = availableLots / totalLots;

  if (ratio >= 0.45) {
    return {
      className: "is-high",
      color: "#22c55e"
    };
  }

  if (ratio >= 0.2) {
    return {
      className: "is-medium",
      color: "#f59e0b"
    };
  }

  return {
    className: "is-low",
    color: "#ef4444"
  };
};

const getAvailabilityLabel = (availability) => {
  const totalLots = Number(availability?.totalLots);
  const availableLots = Number(availability?.availableLots);

  if (!Number.isFinite(totalLots) || totalLots <= 0 || !Number.isFinite(availableLots)) {
    return "Lots unavailable";
  }

  return `${Math.max(availableLots, 0)} / ${totalLots} lots`;
};

const getReferenceCenter = () => {
  if (Number.isFinite(driveUserLocation?.lat) && Number.isFinite(driveUserLocation?.lng)) {
    return {
      lat: driveUserLocation.lat,
      lng: driveUserLocation.lng,
      source: "user-location"
    };
  }

  if (driveMap?.getCenter) {
    const center = driveMap.getCenter();

    if (Number.isFinite(center?.lat) && Number.isFinite(center?.lng)) {
      return {
        lat: center.lat,
        lng: center.lng,
        source: "map-center"
      };
    }
  }

  return {
    lat: DRIVE_DEFAULT_CENTER[0],
    lng: DRIVE_DEFAULT_CENTER[1],
    source: "default"
  };
};

const setReferenceLabel = (source, searchMode = "within-radius") => {
  if (!driveReferenceLabelElement) {
    return;
  }

  if (searchMode === "nearest-fallback") {
    driveReferenceLabelElement.textContent = "Closest in Singapore";
    return;
  }

  driveReferenceLabelElement.textContent =
    source === "user-location" ? "Near your location" : "Near map center";
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
  if (!window.L || !driveUserLayerGroup || !driveUserLocation) {
    return;
  }

  const latLng = [driveUserLocation.lat, driveUserLocation.lng];

  if (!driveUserLocationMarker) {
    driveUserLocationMarker = window.L.marker(latLng, {
      icon: createUserLocationIcon(),
      keyboard: false,
      zIndexOffset: 1200
    }).addTo(driveUserLayerGroup);
    return;
  }

  driveUserLocationMarker.setLatLng(latLng);
};

const updateUserLocation = (position, { centerMap = false } = {}) => {
  const latitude = Number(position?.coords?.latitude);
  const longitude = Number(position?.coords?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return;
  }

  driveUserLocation = {
    lat: latitude,
    lng: longitude,
    accuracyMeters: Number(position?.coords?.accuracy) || null
  };

  syncUserLocationMarker();

  if (centerMap && driveMap && !driveHasCenteredOnUserLocation) {
    driveHasCenteredOnUserLocation = true;
    const currentZoom = Number(driveMap.getZoom()) || DRIVE_DEFAULT_ZOOM;

    driveMap.flyTo([latitude, longitude], Math.max(currentZoom, 15), {
      animate: true,
      duration: 0.7
    });
  }

  void refreshDriveDashboard();
};

const requestUserLocation = () => {
  if (!navigator.geolocation) {
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      updateUserLocation(position, {
        centerMap: true
      });
    },
    (error) => {
      console.warn("Drive user location could not be resolved.", error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: USER_LOCATION_MAX_AGE_MS,
      timeout: USER_LOCATION_TIMEOUT_MS
    }
  );
};

const createCarparkIcon = (carpark) => {
  const tone = getAvailabilityTone(carpark?.availability);

  return window.L.divIcon({
    className: "",
    html: `
      <span class="map-carpark-pin" style="--carpark-tone: ${tone.color}" aria-hidden="true">
        <span class="map-carpark-pin__core"></span>
      </span>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8]
  });
};

const createCarparkPopupContent = (carpark) => {
  const title = escapeHtml(carpark?.address || carpark?.carparkNo || "Carpark");
  const subtitle = escapeHtml(carpark?.carparkNo || "");
  const availabilityLabel = getAvailabilityLabel(carpark?.availability);
  const lotType = escapeHtml(carpark?.availability?.lotType || "C");
  const updatedLabel = escapeHtml(formatUpdatedLabel(carpark?.availability?.updatedAt));
  const priceLabel = escapeHtml(carpark?.priceLabel || "Price unavailable");
  const priceNotes = escapeHtml(
    carpark?.priceNotes || "Verify final rates at signage or parking.sg before parking."
  );

  return `
    <article class="map-stop-sheet">
      <div class="map-stop-sheet__header">
        <div class="map-stop-sheet__title-block">
          <h3 class="map-stop-sheet__title">${title}</h3>
          <p class="map-stop-sheet__subtitle">${subtitle}</p>
        </div>
      </div>
      <div class="map-stop-sheet__cards">
        <section class="map-stop-sheet__card">
          <div class="map-stop-sheet__card-header">
            <span class="map-stop-sheet__mini-chip">Lots</span>
            <span class="map-stop-sheet__card-title">${escapeHtml(availabilityLabel)}</span>
          </div>
          <p class="map-stop-sheet__message">${updatedLabel} Lot type: ${lotType}.</p>
        </section>
        <section class="map-stop-sheet__card">
          <div class="map-stop-sheet__card-header">
            <span class="map-stop-sheet__mini-chip">Price</span>
            <span class="map-stop-sheet__card-title">${priceLabel}</span>
          </div>
          <p class="map-stop-sheet__message">${priceNotes}</p>
        </section>
      </div>
    </article>
  `;
};

const renderDriveList = (
  carparks,
  {
    searchMode = "within-radius",
    radiusMeters = DRIVE_DEFAULT_RADIUS_METERS,
    noticeText = ""
  } = {}
) => {
  if (!driveListElement) {
    return;
  }

  if (!Array.isArray(carparks) || !carparks.length) {
    driveListElement.innerHTML = `
      <p class="workspace-drive__empty">No nearby carparks were found for this map view. Move the map or zoom out to search again.</p>
    `;
    return;
  }

  const fallbackNoticeMarkup =
    searchMode === "nearest-fallback"
      ? `
        <p class="workspace-drive__notice">
          No matches were found within ${(radiusMeters / 1_000).toFixed(1)} km. Showing the nearest carparks in Singapore.
        </p>
      `
      : "";
  const reconnectNoticeMarkup = noticeText
    ? `
      <p class="workspace-drive__notice workspace-drive__notice--sync">
        ${escapeHtml(noticeText)}
      </p>
    `
    : "";

  const markup = carparks
    .slice(0, DRIVE_LIST_LIMIT)
    .map((carpark) => {
      const tone = getAvailabilityTone(carpark?.availability);
      const availabilityLabel = getAvailabilityLabel(carpark?.availability);
      const distanceLabel = formatDistanceLabel(carpark?.distanceMeters);
      const parkingType = escapeHtml(carpark?.carparkType || "Carpark");
      const carparkNo = escapeHtml(carpark?.carparkNo || "");
      const address = escapeHtml(carpark?.address || "Address unavailable");
      const priceLabel = escapeHtml(carpark?.priceLabel || "Price unavailable");

      return `
        <article class="workspace-nearest-card workspace-drive-card" role="listitem" data-carpark-no="${carparkNo}">
          <div class="workspace-nearest-card__header">
            <span class="workspace-nearest-card__service">${carparkNo}</span>
            <span class="workspace-nearest-card__distance">${escapeHtml(distanceLabel)}</span>
          </div>
          <p class="workspace-nearest-card__stop">${address}</p>
          <p class="workspace-nearest-card__meta workspace-drive-card__meta">${parkingType}</p>
          <div class="workspace-nearest-card__times workspace-drive-card__chips">
            <span class="workspace-nearest-card__time-chip workspace-drive-chip--lots ${tone.className}">
              ${escapeHtml(availabilityLabel)}
            </span>
            <span class="workspace-nearest-card__time-chip">${priceLabel}</span>
          </div>
        </article>
      `;
    })
    .join("");

  driveListElement.innerHTML = `${reconnectNoticeMarkup}${fallbackNoticeMarkup}${markup}`;
};

const syncDriveMarkers = (carparks) => {
  if (!window.L || !driveCarparkLayerGroup) {
    return;
  }

  const nextMarkers = new Map();

  for (const carpark of carparks) {
    if (!Number.isFinite(carpark?.lat) || !Number.isFinite(carpark?.lng) || !carpark?.carparkNo) {
      continue;
    }

    const markerId = String(carpark.carparkNo);
    const latLng = [carpark.lat, carpark.lng];

    let marker = driveMarkersByCarparkNo.get(markerId);

    if (!marker) {
      marker = window.L.marker(latLng, {
        icon: createCarparkIcon(carpark),
        keyboard: false,
        zIndexOffset: 760
      })
        .bindPopup(createCarparkPopupContent(carpark), {
          maxWidth: 380,
          closeButton: false
        })
        .addTo(driveCarparkLayerGroup);
    } else {
      marker.setLatLng(latLng);
      marker.setIcon(createCarparkIcon(carpark));
      marker.setPopupContent(createCarparkPopupContent(carpark));
    }

    nextMarkers.set(markerId, marker);
  }

  for (const [markerId, marker] of driveMarkersByCarparkNo.entries()) {
    if (nextMarkers.has(markerId)) {
      continue;
    }

    marker.remove();
  }

  driveMarkersByCarparkNo = nextMarkers;
};

const refreshDriveDashboard = async () => {
  if (!driveMap) {
    return;
  }

  const requestSequence = ++driveRenderSequence;
  const referenceCenter = getReferenceCenter();
  setReferenceLabel(referenceCenter.source);

  const query = new URLSearchParams({
    lat: referenceCenter.lat.toFixed(6),
    lng: referenceCenter.lng.toFixed(6),
    radius: String(DRIVE_DEFAULT_RADIUS_METERS),
    limit: String(DRIVE_DEFAULT_LIMIT)
  });

  try {
    const payload = await fetchJson(`/api/drive/carparks?${query.toString()}`);

    if (requestSequence !== driveRenderSequence) {
      return;
    }

    const carparks = Array.isArray(payload?.carparks) ? payload.carparks : [];
    const searchMode = String(payload?.searchMode || "within-radius");
    const payloadRadius = Number(payload?.radiusMeters);
    const effectiveRadiusMeters = Number.isFinite(payloadRadius)
      ? payloadRadius
      : DRIVE_DEFAULT_RADIUS_METERS;

    driveLastSuccessfulState = {
      carparks,
      searchMode,
      radiusMeters: effectiveRadiusMeters,
      referenceSource: referenceCenter.source
    };

    setReferenceLabel(referenceCenter.source, searchMode);
    syncDriveMarkers(carparks);
    renderDriveList(carparks, {
      searchMode,
      radiusMeters: effectiveRadiusMeters
    });
  } catch (error) {
    console.error("Drive carpark refresh failed.", error);

    if (requestSequence !== driveRenderSequence) {
      return;
    }

    if (driveLastSuccessfulState?.carparks?.length) {
      setReferenceLabel(
        driveLastSuccessfulState.referenceSource || referenceCenter.source,
        driveLastSuccessfulState.searchMode
      );
      syncDriveMarkers(driveLastSuccessfulState.carparks);
      renderDriveList(driveLastSuccessfulState.carparks, {
        searchMode: driveLastSuccessfulState.searchMode,
        radiusMeters: driveLastSuccessfulState.radiusMeters,
        noticeText: "Live updates delayed. Showing last available results while reconnecting."
      });
      return;
    }

    if (driveListElement) {
      driveListElement.innerHTML = `
        <p class="workspace-drive__empty">Connecting to live carpark feed. Retrying automatically.</p>
      `;
    }
  }
};

const scheduleDriveRefresh = () => {
  window.clearTimeout(driveRefreshTimerId);
  driveRefreshTimerId = window.setTimeout(async () => {
    await refreshDriveDashboard();
    scheduleDriveRefresh();
  }, DRIVE_REFRESH_INTERVAL_MS);
};

const stopDriveRefresh = () => {
  window.clearTimeout(driveRefreshTimerId);
};

const setupDriveListInteraction = () => {
  if (!driveListElement) {
    return;
  }

  driveListElement.addEventListener("click", (event) => {
    const listCard = event.target?.closest?.("[data-carpark-no]");

    if (!listCard || !driveMap) {
      return;
    }

    const markerId = listCard.dataset.carparkNo;
    const marker = markerId ? driveMarkersByCarparkNo.get(markerId) : null;

    if (!marker) {
      return;
    }

    const markerPosition = marker.getLatLng();

    driveMap.setView(markerPosition, Math.max(Number(driveMap.getZoom()) || 0, 16), {
      animate: true,
      duration: 0.45
    });
    marker.openPopup();
  });
};

const initializeDriveMap = async () => {
  if (!driveSectionElement || !driveListElement) {
    return;
  }

  if (driveMapInitialized && driveMap) {
    driveMap.invalidateSize();
    await refreshDriveDashboard();
    scheduleDriveRefresh();
    return;
  }

  try {
    const L = await waitForLeaflet();

    driveMap = L.map(DRIVE_MAP_CONTAINER_ID, {
      attributionControl: false,
      zoomControl: false,
      preferCanvas: true,
      minZoom: 11
    }).setView(DRIVE_DEFAULT_CENTER, DRIVE_DEFAULT_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19
    }).addTo(driveMap);

    driveCarparkLayerGroup = L.layerGroup().addTo(driveMap);
    driveUserLayerGroup = L.layerGroup().addTo(driveMap);

    driveMap.on("moveend", () => {
      void refreshDriveDashboard();
    });

    setupDriveListInteraction();
    requestUserLocation();
    driveMapInitialized = true;

    await refreshDriveDashboard();
    scheduleDriveRefresh();
  } catch (error) {
    console.error("Drive map bootstrap failed.", error);

    if (driveListElement) {
      driveListElement.innerHTML = `
        <p class="workspace-drive__empty">Drive map could not be initialized right now.</p>
      `;
    }
  }
};

const handleWorkspaceViewChange = (event) => {
  const viewName = event?.detail?.viewName;

  if (viewName !== "drive") {
    stopDriveRefresh();
    return;
  }

  void initializeDriveMap();
};

window.addEventListener("workspace:viewchange", handleWorkspaceViewChange);

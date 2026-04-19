import ntuCampusShuttleSource from "./data/ntu-campus-shuttle.js";

const LTA_ACCOUNT_KEY = normalizeLtaAccountKey(process.env.LTA_ACCOUNT_KEY);
const LTA_BASE_URL = "https://datamall2.mytransport.sg/ltaodataservice";
const ARRIVELAH_BASE_URL = "https://arrivelah2.busrouter.sg/";
const BUSROUTER_BASE_URL = "https://data.busrouter.sg/v1";
const NTU_OMNIBUS_BASE_URL = "https://apps.ntu.edu.sg/NTUOmnibus/";

const PUBLIC_BUS_SERVICES = ["179", "199"];
const CAMPUS_SHUTTLE_SERVICES = Object.keys(ntuCampusShuttleSource.services);
const SERVICES = [...PUBLIC_BUS_SERVICES, ...CAMPUS_SHUTTLE_SERVICES];
const PUBLIC_LIVE_SERVICE_SET = new Set(PUBLIC_BUS_SERVICES);

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);
const STATIC_CACHE_TTL_MS = Number(process.env.STATIC_CACHE_TTL_MS || 12 * 60 * 60 * 1000);
const NTU_OMNIBUS_MODULE_VERSION_TTL_MS = Number(
  process.env.NTU_OMNIBUS_MODULE_VERSION_TTL_MS || 30 * 60 * 1000
);
const CAMPUS_ESTIMATED_SPEED_METERS_PER_MINUTE = Number(
  process.env.CAMPUS_ESTIMATED_SPEED_METERS_PER_MINUTE || 230
);
const CAMPUS_STOP_DWELL_MINUTES = Number(process.env.CAMPUS_STOP_DWELL_MINUTES || 0.35);
const CAMPUS_STOP_MATCH_DISTANCE_METERS = Number(
  process.env.CAMPUS_STOP_MATCH_DISTANCE_METERS || 45
);
const CAMPUS_ROUTE_MATCH_DISTANCE_METERS = Number(
  process.env.CAMPUS_ROUTE_MATCH_DISTANCE_METERS || 140
);

const NTU_VIEW = {
  center: {
    lat: 1.3483,
    lng: 103.6831
  },
  zoom: 14.7
};

const SERVICE_COLORS = {
  "179": "#ff4fa3",
  "199": "#ff6b35",
  ...Object.fromEntries(
    CAMPUS_SHUTTLE_SERVICES.map((serviceNo) => [
      serviceNo,
      ntuCampusShuttleSource.services[serviceNo].color
    ])
  )
};

const CAMPUS_OMNIBUS_ROUTE_MAP = {
  "CL-B": {
    routeName: "Blue",
    routeColorCode: "0054A6"
  },
  "CL-R": {
    routeName: "Red",
    routeColorCode: "C1272D"
  },
  CR: {
    routeName: "Green",
    routeColorCode: "1E9D61"
  },
  CWR: {
    routeName: "Brown",
    routeColorCode: "8A5A3C"
  }
};

const NTU_OMNIBUS_API = {
  activeBusServicesData: "ZqTN65XW1uKLZ0T8NTg0jw"
};

const NTU_OMNIBUS_CLIENT_VARIABLES = {
  SGHO_RouteColorCode: "D9860A",
  NTU_RouteColorCode:
    "{'data':[{'route_code':'Blue','color_code':'0054A6','Order':'2'},{'route_code':'Green','color_code':'007C48','Order':'3'},{'route_code':'Brown','color_code':'866D4B','Order':'4'},{'route_code':'Red','color_code':'D71440','Order':'1'},{'route_code':'179','color_code':'944496','Order':'5'},{'route_code':'179A','color_code':'944496','Order':'6'},{'route_code':'199','color_code':'944496','Order':'7'},{'route_code':'default','color_code':'181C62','Order':'8'}]}"
};

const NTU_OMNIBUS_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json; charset=UTF-8",
  "X-CSRFToken": "T6C+9iB49TLra4jEsMeSckDMNhQ="
};

const routeCache = {
  data: null,
  fetchedAt: 0,
  pending: null
};

const ntuOmnibusModuleVersionCache = {
  value: null,
  fetchedAt: 0,
  pending: null
};

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export function registerMapApiRoutes(app) {
  app.get("/api/map/health", (_req, res) => {
    res.json({
      ok: true,
      configured: Boolean(LTA_ACCOUNT_KEY),
      services: SERVICES,
      center: NTU_VIEW.center,
      zoom: NTU_VIEW.zoom
    });
  });

  app.get("/api/map/routes", async (_req, res) => {
    try {
      const dataset = await getRouteDataset();
      res.json(publicRouteDataset(dataset));
    } catch (error) {
      handleApiError(res, error);
    }
  });

  app.get("/api/map/vehicles", async (_req, res) => {
    try {
      const dataset = await getRouteDataset();
      const [publicVehicles, campusVehicles] = await Promise.all([
        collectPublicVehicles(dataset),
        collectCampusVehicles(dataset)
      ]);

      res.json({
        updatedAt: new Date().toISOString(),
        services: SERVICES,
        vehicles: dedupeVehicles([...publicVehicles, ...campusVehicles])
      });
    } catch (error) {
      handleApiError(res, error);
    }
  });

  app.get("/api/map/stops/:stopCode/arrivals", async (req, res) => {
    try {
      const dataset = await getRouteDataset();
      const stopCode = String(req.params.stopCode || "").trim();
      const stopMeta = dataset.stopLookup[stopCode];

      if (!stopMeta) {
        throw new ApiError(404, `No mapped stop exists for code ${stopCode}.`);
      }

      const campusServiceNos = stopMeta.services.filter((serviceNo) =>
        CAMPUS_SHUTTLE_SERVICES.includes(serviceNo)
      );

      const [publicStopResponse, campusArrivalsByService] = await Promise.all([
        (async () => {
          try {
            return await getPublicStopLiveResponse(stopMeta);
          } catch {
            return { services: [] };
          }
        })(),
        campusServiceNos.length
          ? (async () => {
              try {
                const campusVehicles = await collectCampusVehicles(dataset);
                return estimateCampusStopArrivals(stopMeta, dataset, campusVehicles);
              } catch {
                return new Map();
              }
            })()
          : Promise.resolve(new Map())
      ]);

      const publicLookup = new Map(
        (publicStopResponse.services || []).map((service) => [service.serviceNo, service])
      );

      res.json({
        stop: {
          code: stopMeta.code,
          name: stopMeta.name,
          roadName: stopMeta.roadName,
          services: stopMeta.services
        },
        services: stopMeta.services.map((serviceNo) => {
          const serviceMeta = dataset.services?.[serviceNo] || {};
          const livePublicService = publicLookup.get(serviceNo);
          const isCampusService = CAMPUS_SHUTTLE_SERVICES.includes(serviceNo);
          const livePublicArrivals = Array.isArray(livePublicService?.upcomingBuses)
            ? livePublicService.upcomingBuses.map((bus) => ({
                minutes: bus.minutes,
                estimatedArrival: bus.estimatedArrival,
                visitNumber: bus.visitNumber
              }))
            : [];
          const arrivals = isCampusService
            ? campusArrivalsByService.get(serviceNo) || []
            : livePublicArrivals;

          return {
            serviceNo,
            shortLabel: serviceMeta.shortLabel || serviceNo,
            title: serviceMeta.title || serviceNo,
            color: serviceMeta.color || SERVICE_COLORS[serviceNo] || "#8b5cf6",
            operates: serviceMeta.operates || (isCampusService ? "Campus shuttle" : "Public bus"),
            isCampusService,
            availability:
              arrivals.length > 0
                ? isCampusService
                  ? "estimated"
                  : "live"
                : "no-estimate",
            arrivals
          };
        })
      });
    } catch (error) {
      handleApiError(res, error);
    }
  });
}

async function getRouteDataset() {
  const cacheAge = Date.now() - routeCache.fetchedAt;

  if (routeCache.data && cacheAge < STATIC_CACHE_TTL_MS) {
    return routeCache.data;
  }

  if (routeCache.pending) {
    return routeCache.pending;
  }

  routeCache.pending = hydrateRouteDataset()
    .then((dataset) => {
      routeCache.data = dataset;
      routeCache.fetchedAt = Date.now();
      return dataset;
    })
    .finally(() => {
      routeCache.pending = null;
    });

  return routeCache.pending;
}

async function hydrateRouteDataset() {
  const [geometryIndex, campusDataset] = await Promise.all([
    getPublicRouteGeometryIndex(),
    Promise.resolve(hydrateCampusShuttleDataset())
  ]);

  let publicDataset;

  try {
    publicDataset = await hydrateFallbackRouteDataset(geometryIndex);
  } catch {
    publicDataset = createEmptyPublicDataset();
  }

  return mergeRouteDatasets(publicDataset, campusDataset);
}

function createEmptyPublicDataset() {
  const services = Object.fromEntries(
    PUBLIC_BUS_SERVICES.map((serviceNo) => [
      serviceNo,
      {
        color: SERVICE_COLORS[serviceNo],
        title: `Bus ${serviceNo}`,
        shortLabel: serviceNo,
        operates: "Unavailable",
        directions: []
      }
    ])
  );

  return {
    generatedAt: new Date().toISOString(),
    center: NTU_VIEW.center,
    zoom: NTU_VIEW.zoom,
    source: "campus-only",
    services,
    stops: [],
    stopLookup: {}
  };
}

function hydrateCampusShuttleDataset() {
  const stopMembership = new Map();

  for (const [serviceNo, service] of Object.entries(ntuCampusShuttleSource.services)) {
    for (const [stopCode] of service.stops) {
      if (!stopMembership.has(stopCode)) {
        stopMembership.set(stopCode, new Set());
      }

      stopMembership.get(stopCode).add(serviceNo);
    }
  }

  const stops = Object.entries(ntuCampusShuttleSource.stops)
    .map(([stopCode, stop]) => ({
      code: stopCode,
      ...stop,
      services: Array.from(stopMembership.get(stopCode) || []).sort(
        (left, right) => SERVICES.indexOf(left) - SERVICES.indexOf(right)
      ),
      omnibusCodes: {
        ...Object.fromEntries(
          Array.from(stopMembership.get(stopCode) || []).map((serviceNo) => [serviceNo, stopCode])
        )
      }
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const services = Object.fromEntries(
    Object.entries(ntuCampusShuttleSource.services).map(([serviceNo, service]) => [
      serviceNo,
      {
        color: service.color,
        title: service.title,
        shortLabel: service.shortLabel,
        operates: service.operates,
        summary: service.summary,
        frequencies: service.frequencies,
        directions: [
          {
            direction: 1,
            path: decodePolyline(service.path),
            stops: service.stops.map(([stopCode, label, firstBusTime], index) => {
              const stop = ntuCampusShuttleSource.stops[stopCode];

              return {
                code: stopCode,
                name: stop.name,
                roadName: stop.roadName,
                lat: stop.lat,
                lng: stop.lng,
                label,
                firstBusTime,
                stopSequence: index + 1,
                distanceKm: null
              };
            })
          }
        ]
      }
    ])
  );

  return {
    generatedAt: ntuCampusShuttleSource.generatedAt,
    center: ntuCampusShuttleSource.center,
    zoom: ntuCampusShuttleSource.zoom,
    source: ntuCampusShuttleSource.source,
    services,
    stops,
    stopLookup: Object.fromEntries(stops.map((stop) => [stop.code, stop]))
  };
}

async function getPublicRouteGeometryIndex() {
  const geoJsonIndex = await getPublicGeoJsonRouteGeometryIndex();

  if (geoJsonIndex) {
    return geoJsonIndex;
  }

  const routeIndex = await fetchPublicJson(`${BUSROUTER_BASE_URL}/routes.min.json`);

  return Object.fromEntries(
    PUBLIC_BUS_SERVICES.map((serviceNo) => [
      serviceNo,
      Array.isArray(routeIndex?.[serviceNo])
        ? routeIndex[serviceNo].map((encodedPath) => decodePolyline(encodedPath))
        : []
    ])
  );
}

async function getPublicGeoJsonRouteGeometryIndex() {
  try {
    const routeCollection = await fetchPublicJson(`${BUSROUTER_BASE_URL}/routes.min.geojson`);
    const features = Array.isArray(routeCollection?.features) ? routeCollection.features : [];
    const geometryIndex = Object.fromEntries(PUBLIC_BUS_SERVICES.map((serviceNo) => [serviceNo, []]));

    for (const feature of features) {
      const serviceNo = String(feature?.properties?.number || "");

      if (!PUBLIC_BUS_SERVICES.includes(serviceNo)) {
        continue;
      }

      const pattern = Number(feature?.properties?.pattern || 0);
      const coordinates = normalizeGeoJsonRouteCoordinates(feature?.geometry);

      if (!coordinates.length) {
        continue;
      }

      geometryIndex[serviceNo][pattern] = coordinates;
    }

    const hasGeometry = PUBLIC_BUS_SERVICES.some(
      (serviceNo) => geometryIndex[serviceNo].length > 0
    );

    return hasGeometry ? geometryIndex : null;
  } catch {
    return null;
  }
}

function normalizeGeoJsonRouteCoordinates(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === "LineString") {
    return geometry.coordinates
      .map((coordinatePair) => normalizeGeoJsonCoordinatePair(coordinatePair))
      .filter(Boolean);
  }

  if (geometry.type === "MultiLineString") {
    return geometry.coordinates
      .flatMap((segment) =>
        segment.map((coordinatePair) => normalizeGeoJsonCoordinatePair(coordinatePair))
      )
      .filter(Boolean);
  }

  return [];
}

function normalizeGeoJsonCoordinatePair(coordinatePair) {
  const [lng, lat] = Array.isArray(coordinatePair) ? coordinatePair : [];

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return [lat, lng];
}

async function hydrateFallbackRouteDataset(geometryIndex) {
  const [serviceIndex, stopIndex] = await Promise.all([
    fetchPublicJson(`${BUSROUTER_BASE_URL}/services.min.json`),
    fetchPublicJson(`${BUSROUTER_BASE_URL}/stops.min.json`)
  ]);

  const stopServices = new Map();

  const services = Object.fromEntries(
    PUBLIC_BUS_SERVICES.map((serviceNo) => {
      const service = serviceIndex?.[serviceNo];

      if (!service) {
        return [
          serviceNo,
          {
            color: SERVICE_COLORS[serviceNo],
            directions: []
          }
        ];
      }

      const directions = (service.routes || []).map((routeStops, index) => {
        const stops = routeStops
          .map((stopCode, stopIndexWithinRoute) => {
            const stop = stopIndex?.[stopCode];

            if (!stop) {
              return null;
            }

            if (!stopServices.has(stopCode)) {
              stopServices.set(stopCode, new Set());
            }

            stopServices.get(stopCode).add(serviceNo);

            return {
              code: stopCode,
              name: stop[2],
              roadName: stop[3],
              lat: Number(stop[1]),
              lng: Number(stop[0]),
              stopSequence: stopIndexWithinRoute + 1,
              distanceKm: null,
              firstBus: null,
              lastBus: null
            };
          })
          .filter(Boolean);

        return {
          direction: index + 1,
          path: geometryIndex?.[serviceNo]?.[index] || stops.map((stop) => [stop.lat, stop.lng]),
          stops
        };
      });

      return [
        serviceNo,
        {
          color: SERVICE_COLORS[serviceNo],
          title: `Bus ${serviceNo}`,
          shortLabel: serviceNo,
          operates: "Live public bus",
          directions
        }
      ];
    })
  );

  const uniqueStopCodes = new Set(
    Object.values(services).flatMap((service) =>
      service.directions.flatMap((direction) => direction.stops.map((stop) => stop.code))
    )
  );

  const stops = Array.from(uniqueStopCodes)
    .map((stopCode) => {
      const stop = stopIndex?.[stopCode];

      if (!stop) {
        return null;
      }

      return {
        code: stopCode,
        name: stop[2],
        roadName: stop[3],
        lat: Number(stop[1]),
        lng: Number(stop[0]),
        services: Array.from(stopServices.get(stopCode) || []).sort(),
        omnibusCodes: {}
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));

  if (!stops.length) {
    throw new ApiError(502, "The fallback route dataset could not be loaded.");
  }

  return {
    generatedAt: new Date().toISOString(),
    center: NTU_VIEW.center,
    zoom: NTU_VIEW.zoom,
    source: "public-fallback",
    services,
    stops,
    stopLookup: Object.fromEntries(stops.map((stop) => [stop.code, stop]))
  };
}

function mergeRouteDatasets(publicDataset, campusDataset) {
  const stopsByCode = new Map();

  for (const stop of [...publicDataset.stops, ...campusDataset.stops]) {
    const existing = stopsByCode.get(stop.code);

    if (!existing) {
      stopsByCode.set(stop.code, {
        ...stop,
        services: [...stop.services],
        omnibusCodes: stop.omnibusCodes ? { ...stop.omnibusCodes } : {}
      });
      continue;
    }

    existing.services = Array.from(new Set([...existing.services, ...stop.services])).sort(
      (left, right) => SERVICES.indexOf(left) - SERVICES.indexOf(right)
    );
    existing.omnibusCodes = {
      ...(existing.omnibusCodes || {}),
      ...(stop.omnibusCodes || {})
    };
  }

  const stops = Array.from(stopsByCode.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  return {
    generatedAt: new Date().toISOString(),
    center: NTU_VIEW.center,
    zoom: NTU_VIEW.zoom,
    source: "combined",
    services: {
      ...publicDataset.services,
      ...campusDataset.services
    },
    stops,
    stopLookup: Object.fromEntries(stops.map((stop) => [stop.code, stop]))
  };
}

async function collectPublicVehicles(dataset) {
  const stopCodes = dataset.stops
    .filter((stop) => stop.services.some((serviceNo) => PUBLIC_LIVE_SERVICE_SET.has(serviceNo)))
    .map((stop) => stop.code);

  const stopResponses = await mapWithConcurrency(stopCodes, 6, async (busStopCode) => {
    const stopMeta = dataset.stopLookup[busStopCode];

    if (!stopMeta) {
      return null;
    }

    try {
      const liveResponse = await getPublicStopLiveResponse(stopMeta);

      return {
        ...liveResponse,
        stop: {
          code: stopMeta.code,
          name: stopMeta.name || stopMeta.code
        }
      };
    } catch {
      return null;
    }
  });

  return collectLiveVehicles(stopResponses);
}

async function getPublicStopLiveResponse(stopMeta) {
  const publicServices = stopMeta.services.filter((serviceNo) => PUBLIC_LIVE_SERVICE_SET.has(serviceNo));

  if (!publicServices.length) {
    return {
      services: []
    };
  }

  if (LTA_ACCOUNT_KEY) {
    const payload = await fetchDatamallJson("/v3/BusArrival", {
      BusStopCode: stopMeta.code
    });

    const serviceLookup = new Map(
      (Array.isArray(payload?.Services) ? payload.Services : [])
        .filter((entry) => PUBLIC_BUS_SERVICES.includes(String(entry.ServiceNo)))
        .map((entry) => [String(entry.ServiceNo), entry])
    );

    return {
      services: publicServices.map((serviceNo) => {
        const service = serviceLookup.get(serviceNo);
        const upcomingBuses = [service?.NextBus, service?.NextBus2, service?.NextBus3]
          .map((bus, index) => normalizeNextBus(bus || null, index + 1))
          .filter(Boolean);

        return {
          serviceNo,
          color: SERVICE_COLORS[serviceNo],
          upcomingBuses
        };
      })
    };
  }

  const payload = await fetchArriveLahJson(stopMeta.code);
  const serviceLookup = new Map(
    (Array.isArray(payload?.services) ? payload.services : [])
      .filter((entry) => PUBLIC_BUS_SERVICES.includes(String(entry?.no)))
      .map((entry) => [String(entry.no), entry])
  );

  return {
    services: publicServices.map((serviceNo) => {
      const service = serviceLookup.get(serviceNo);

      return {
        serviceNo,
        color: SERVICE_COLORS[serviceNo],
        upcomingBuses: normalizeArriveLahUpcomingBuses(service)
      };
    })
  };
}

async function collectCampusVehicles(dataset) {
  const campusVehicles = await Promise.all(
    CAMPUS_SHUTTLE_SERVICES.map(async (serviceNo) => {
      try {
        const service = dataset.services?.[serviceNo];
        const routeMetrics = buildCampusRouteMetrics(service?.directions?.[0]);
        const payload = await fetchCampusOmnibusVehicles(serviceNo);
        const vehicleList =
          payload?.data?.Response?.ActiveBusResult?.Activebus?.List ||
          payload?.data?.ActiveBusResult?.Activebus?.List ||
          [];

        return vehicleList
          .map((vehicle) => normalizeCampusVehicle(serviceNo, vehicle, dataset, routeMetrics))
          .filter(Boolean);
      } catch {
        return [];
      }
    })
  );

  return campusVehicles.flat();
}

function normalizeCampusVehicle(serviceNo, vehicle, dataset, routeMetrics) {
  const lat = Number(vehicle?.Lat);
  const lng = Number(vehicle?.Lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const service = dataset.services?.[serviceNo];
  const speedKph = Number.isFinite(Number(vehicle?.Speed)) ? Number(vehicle.Speed) : null;
  const nextStop = getCampusVehicleNextStop(service, routeMetrics, lat, lng, speedKph);
  const crowdLevel = normalizeCampusCrowdLevel(vehicle?.LoadInfo?.CrowdLevel);
  const occupancy = parseFiniteNumber(vehicle?.LoadInfo?.Occupancy);
  const capacity = parseFiniteNumber(vehicle?.LoadInfo?.Capacity);
  const ridership = parseFiniteNumber(vehicle?.LoadInfo?.Ridership);

  return {
    id: `${serviceNo}:${String(vehicle?.Vehplate || `${lat.toFixed(5)}:${lng.toFixed(5)}`)}`,
    serviceNo,
    color: SERVICE_COLORS[serviceNo],
    lat,
    lng,
    isCampusService: true,
    vehiclePlate: String(vehicle?.Vehplate || "").trim() || null,
    speedKph,
    crowdLevel,
    occupancy,
    capacity,
    ridership,
    bearing: Number.isFinite(Number(vehicle?.Direction)) ? Number(vehicle.Direction) : null,
    nextStopCode: nextStop?.code || null,
    nextStopName: nextStop?.name || service?.title || serviceNo,
    nextStopMinutes: nextStop?.minutes ?? null
  };
}

function getCampusVehicleNextStop(service, routeMetrics, lat, lng, speedKph) {
  const route = service?.directions?.[0];
  const stops = route?.stops || [];

  if (!route || !stops.length) {
    return null;
  }

  const vehicleProjection = getNearestRouteProjection(routeMetrics, lat, lng);

  if (!vehicleProjection || vehicleProjection.distance > CAMPUS_ROUTE_MATCH_DISTANCE_METERS) {
    const nearestStop = findNearestServiceStop(service, lat, lng);

    if (!nearestStop) {
      return null;
    }

    return {
      code: nearestStop.code,
      name: nearestStop.name,
      minutes: estimateMinutesFromDistance(
        getDistanceMeters(lat, lng, nearestStop.lat, nearestStop.lng),
        speedKph
      )
    };
  }

  let bestCandidate = null;

  for (const stop of stops) {
    const stopProgress = routeMetrics.stopProgressByCode.get(stop.code);

    if (!Number.isFinite(stopProgress)) {
      continue;
    }

    const directDistance = getDistanceMeters(lat, lng, stop.lat, stop.lng);
    const forwardDistance = getForwardLoopDistance(
      routeMetrics.totalDistance,
      vehicleProjection.progress,
      stopProgress
    );

    if (!bestCandidate || forwardDistance < bestCandidate.forwardDistance) {
      bestCandidate = {
        code: stop.code,
        name: stop.name,
        directDistance,
        forwardDistance
      };
    }
  }

  if (!bestCandidate) {
    return null;
  }

  const effectiveDistance =
    bestCandidate.directDistance <= CAMPUS_STOP_MATCH_DISTANCE_METERS
      ? 0
      : bestCandidate.forwardDistance;

  return {
    code: bestCandidate.code,
    name: bestCandidate.name,
    minutes: estimateMinutesFromDistance(effectiveDistance, speedKph)
  };
}

function estimateCampusStopArrivals(stopMeta, dataset, campusVehicles) {
  const arrivalsByService = new Map();

  for (const serviceNo of stopMeta.services) {
    if (!CAMPUS_SHUTTLE_SERVICES.includes(serviceNo)) {
      continue;
    }

    const service = dataset.services?.[serviceNo];
    const route = service?.directions?.[0];
    const targetStop = route?.stops?.find((stop) => stop.code === stopMeta.code);

    if (!route || !targetStop) {
      arrivalsByService.set(serviceNo, []);
      continue;
    }

    const routeMetrics = buildCampusRouteMetrics(route);
    const targetProjection = getNearestRouteProjection(routeMetrics, targetStop.lat, targetStop.lng);

    if (
      !targetProjection ||
      targetProjection.distance > CAMPUS_ROUTE_MATCH_DISTANCE_METERS
    ) {
      arrivalsByService.set(serviceNo, []);
      continue;
    }

    const vehicleArrivals = campusVehicles
      .filter((vehicle) => vehicle.serviceNo === serviceNo)
      .map((vehicle) =>
        estimateCampusVehicleArrival(
          vehicle,
          route,
          routeMetrics,
          targetStop,
          targetProjection.progress
        )
      )
      .filter(Boolean)
      .sort((left, right) => left.minutes - right.minutes);

    const nextArrivals = vehicleArrivals.slice(0, 2);
    const cycleMinutes = getCampusRouteCycleMinutes(route, routeMetrics);

    if (nextArrivals.length === 1 && Number.isFinite(cycleMinutes) && cycleMinutes > 0) {
      const firstArrival = nextArrivals[0];
      nextArrivals.push(
        createEstimatedArrival(firstArrival.minutes + Math.max(Math.round(cycleMinutes), 1), 2)
      );
    }

    arrivalsByService.set(
      serviceNo,
      nextArrivals.map((arrival, index) => ({
        minutes: arrival.minutes,
        estimatedArrival: arrival.estimatedArrival,
        visitNumber: index + 1
      }))
    );
  }

  return arrivalsByService;
}

function estimateCampusVehicleArrival(vehicle, route, routeMetrics, targetStop, targetProgress) {
  const vehicleProjection = getNearestRouteProjection(routeMetrics, vehicle.lat, vehicle.lng);

  if (!vehicleProjection || vehicleProjection.distance > CAMPUS_ROUTE_MATCH_DISTANCE_METERS) {
    return null;
  }

  const directDistanceToStop = getDistanceMeters(vehicle.lat, vehicle.lng, targetStop.lat, targetStop.lng);

  if (directDistanceToStop <= CAMPUS_STOP_MATCH_DISTANCE_METERS) {
    return createEstimatedArrival(0, 1);
  }

  const forwardDistance = getForwardLoopDistance(
    routeMetrics.totalDistance,
    vehicleProjection.progress,
    targetProgress
  );
  const intermediateStops = countIntermediateStopsAhead(
    route,
    routeMetrics,
    vehicleProjection.progress,
    targetProgress,
    targetStop.code
  );
  const rawMinutes =
    forwardDistance / CAMPUS_ESTIMATED_SPEED_METERS_PER_MINUTE +
    intermediateStops * CAMPUS_STOP_DWELL_MINUTES;

  return createEstimatedArrival(Math.max(Math.ceil(rawMinutes), 1), 1);
}

function buildCampusRouteMetrics(route) {
  const path = Array.isArray(route?.path) ? route.path.filter(isValidRoutePoint) : [];

  if (!path.length) {
    return {
      path: [],
      cumulativeDistances: [0],
      totalDistance: 0,
      stopProgressByCode: new Map()
    };
  }

  const cumulativeDistances = [0];

  for (let index = 1; index < path.length; index += 1) {
    const [previousLat, previousLng] = path[index - 1];
    const [currentLat, currentLng] = path[index];
    cumulativeDistances[index] =
      cumulativeDistances[index - 1] +
      getDistanceMeters(previousLat, previousLng, currentLat, currentLng);
  }

  const routeMetrics = {
    path,
    cumulativeDistances,
    totalDistance: cumulativeDistances[cumulativeDistances.length - 1] || 0,
    stopProgressByCode: new Map()
  };

  for (const stop of route?.stops || []) {
    const projection = getNearestRouteProjection(routeMetrics, stop.lat, stop.lng);

    if (projection) {
      routeMetrics.stopProgressByCode.set(stop.code, projection.progress);
    }
  }

  return routeMetrics;
}

function getNearestRouteProjection(routeMetrics, lat, lng) {
  const path = routeMetrics?.path || [];
  const cumulativeDistances = routeMetrics?.cumulativeDistances || [];

  if (!path.length || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (path.length === 1) {
    const [pointLat, pointLng] = path[0];
    return {
      distance: getDistanceMeters(lat, lng, pointLat, pointLng),
      progress: 0
    };
  }

  let nearestProjection = null;

  for (let index = 1; index < path.length; index += 1) {
    const [startLat, startLng] = path[index - 1];
    const [endLat, endLng] = path[index];
    const startPoint = projectToLocalMeters(lat, lng, startLat, startLng);
    const endPoint = projectToLocalMeters(lat, lng, endLat, endLng);
    const segmentX = endPoint.x - startPoint.x;
    const segmentY = endPoint.y - startPoint.y;
    const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
    const interpolation =
      segmentLengthSquared > 0
        ? clampToUnit(-(startPoint.x * segmentX + startPoint.y * segmentY) / segmentLengthSquared)
        : 0;
    const projectedX = startPoint.x + segmentX * interpolation;
    const projectedY = startPoint.y + segmentY * interpolation;
    const distance = Math.hypot(projectedX, projectedY);
    const segmentStartProgress = cumulativeDistances[index - 1] || 0;
    const segmentEndProgress = cumulativeDistances[index] || segmentStartProgress;
    const progress =
      segmentStartProgress + (segmentEndProgress - segmentStartProgress) * interpolation;

    if (!nearestProjection || distance < nearestProjection.distance) {
      nearestProjection = {
        distance,
        progress
      };
    }
  }

  return nearestProjection;
}

function projectToLocalMeters(originLat, originLng, lat, lng) {
  const metersPerLatitudeDegree = 111_132;
  const metersPerLongitudeDegree =
    111_320 * Math.cos((((originLat + lat) / 2) * Math.PI) / 180);

  return {
    x: (lng - originLng) * metersPerLongitudeDegree,
    y: (lat - originLat) * metersPerLatitudeDegree
  };
}

function countIntermediateStopsAhead(route, routeMetrics, fromProgress, targetProgress, targetStopCode) {
  const distanceToTarget = getForwardLoopDistance(
    routeMetrics.totalDistance,
    fromProgress,
    targetProgress
  );

  return (route?.stops || []).reduce((count, stop) => {
    if (stop.code === targetStopCode) {
      return count;
    }

    const stopProgress = routeMetrics.stopProgressByCode.get(stop.code);

    if (!Number.isFinite(stopProgress)) {
      return count;
    }

    const distanceToStop = getForwardLoopDistance(
      routeMetrics.totalDistance,
      fromProgress,
      stopProgress
    );

    if (distanceToStop > CAMPUS_STOP_MATCH_DISTANCE_METERS && distanceToStop < distanceToTarget) {
      return count + 1;
    }

    return count;
  }, 0);
}

function getForwardLoopDistance(totalDistance, fromProgress, toProgress) {
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) {
    return 0;
  }

  const from = Number.isFinite(fromProgress) ? fromProgress : 0;
  const to = Number.isFinite(toProgress) ? toProgress : 0;
  const delta = to - from;

  return delta >= 0 ? delta : totalDistance + delta;
}

function getCampusRouteCycleMinutes(route, routeMetrics) {
  const stopCount = Array.isArray(route?.stops) ? route.stops.length : 0;

  if (!Number.isFinite(routeMetrics?.totalDistance) || routeMetrics.totalDistance <= 0) {
    return null;
  }

  return (
    routeMetrics.totalDistance / CAMPUS_ESTIMATED_SPEED_METERS_PER_MINUTE +
    stopCount * CAMPUS_STOP_DWELL_MINUTES
  );
}

function createEstimatedArrival(minutes, visitNumber) {
  const roundedMinutes = Math.max(Math.round(minutes), 0);

  return {
    minutes: roundedMinutes,
    estimatedArrival: new Date(Date.now() + roundedMinutes * 60_000).toISOString(),
    visitNumber
  };
}

function isValidRoutePoint(point) {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  );
}

function clampToUnit(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}

function estimateMinutesFromDistance(distanceMeters, speedKph) {
  if (!Number.isFinite(distanceMeters)) {
    return null;
  }

  if (distanceMeters <= CAMPUS_STOP_MATCH_DISTANCE_METERS) {
    return 0;
  }

  const speedMetersPerMinute = getCampusSpeedMetersPerMinute(speedKph);
  return Math.max(Math.ceil(distanceMeters / speedMetersPerMinute), 1);
}

function getCampusSpeedMetersPerMinute(speedKph) {
  if (Number.isFinite(speedKph) && speedKph > 3) {
    return (speedKph * 1000) / 60;
  }

  return CAMPUS_ESTIMATED_SPEED_METERS_PER_MINUTE;
}

function parseFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCampusCrowdLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "low") {
    return "Low";
  }

  if (normalized === "medium") {
    return "Moderate";
  }

  if (normalized === "high") {
    return "High";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizePublicBusCrowdLevel(value) {
  const normalized = String(value || "").trim().toUpperCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "SEA") {
    return "Low";
  }

  if (normalized === "SDA") {
    return "Moderate";
  }

  if (normalized === "LSD") {
    return "High";
  }

  return normalized;
}

function findNearestServiceStop(service, lat, lng) {
  const stops = service?.directions?.[0]?.stops || [];
  let nearestStop = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const stop of stops) {
    const distance = getDistanceMeters(lat, lng, stop.lat, stop.lng);

    if (distance < nearestDistance) {
      nearestStop = stop;
      nearestDistance = distance;
    }
  }

  return nearestStop;
}

function collectLiveVehicles(stopResponses) {
  const vehiclesById = new Map();

  for (const stopResponse of stopResponses.filter(Boolean)) {
    const stopCode = String(stopResponse?.stop?.code || "").trim() || null;
    const stopName = String(stopResponse?.stop?.name || "").trim() || null;

    for (const service of stopResponse.services || []) {
      for (const bus of service.upcomingBuses || []) {
        if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lng)) {
          continue;
        }

        const vehicleId = [service.serviceNo, bus.lat.toFixed(5), bus.lng.toFixed(5)].join(":");
        const existingVehicle = vehiclesById.get(vehicleId);
        const busMinutes = Number.isFinite(Number(bus.minutes)) ? Number(bus.minutes) : null;
        const existingMinutes = Number.isFinite(existingVehicle?._nearestMinutes)
          ? existingVehicle._nearestMinutes
          : Number.POSITIVE_INFINITY;
        const candidateMinutes = Number.isFinite(busMinutes) ? busMinutes : Number.POSITIVE_INFINITY;

        if (!existingVehicle || candidateMinutes < existingMinutes) {
          vehiclesById.set(vehicleId, {
            id: vehicleId,
            serviceNo: service.serviceNo,
            color: service.color,
            lat: bus.lat,
            lng: bus.lng,
            crowdLevel: bus.crowdLevel,
            busFeature: bus.feature,
            busType: bus.type,
            bearing: null,
            nextStopCode: stopCode,
            nextStopName: stopName,
            nextStopMinutes: busMinutes,
            _nearestMinutes: candidateMinutes
          });
        }
      }
    }
  }

  return Array.from(vehiclesById.values()).map((vehicle) => {
    const { _nearestMinutes, ...cleanVehicle } = vehicle;
    return cleanVehicle;
  });
}

function dedupeVehicles(vehicles) {
  const seen = new Set();

  return vehicles.filter((vehicle) => {
    const key = `${vehicle.serviceNo}:${vehicle.lat?.toFixed?.(5)}:${vehicle.lng?.toFixed?.(5)}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeArriveLahUpcomingBuses(service) {
  const candidates = [service?.next, service?.subsequent, service?.next2, service?.next3];
  const seen = new Set();

  return candidates
    .map((bus, index) => normalizeArriveLahBus(bus, index + 1))
    .filter((bus) => {
      if (!bus) {
        return false;
      }

      const dedupeKey = [
        bus.estimatedArrival,
        Number.isFinite(bus.lat) ? bus.lat.toFixed(5) : "na",
        Number.isFinite(bus.lng) ? bus.lng.toFixed(5) : "na"
      ].join(":");

      if (seen.has(dedupeKey)) {
        return false;
      }

      seen.add(dedupeKey);
      return true;
    });
}

function normalizeArriveLahBus(bus, visitNumber) {
  if (!bus?.time) {
    return null;
  }

  const estimatedArrival = new Date(bus.time);

  if (Number.isNaN(estimatedArrival.getTime())) {
    return null;
  }

  const rawMinutes = Number.isFinite(Number(bus.duration_ms))
    ? Math.round(Number(bus.duration_ms) / 60000)
    : Math.round((estimatedArrival.getTime() - Date.now()) / 60000);

  return {
    estimatedArrival: estimatedArrival.toISOString(),
    minutes: Math.max(rawMinutes, 0),
    visitNumber: Number(bus.visit_number) || visitNumber,
    lat: Number.isFinite(Number(bus.lat)) && Number(bus.lat) > 0 ? Number(bus.lat) : null,
    lng: Number.isFinite(Number(bus.lng)) && Number(bus.lng) > 0 ? Number(bus.lng) : null,
    crowdLevel: normalizePublicBusCrowdLevel(bus.load),
    feature: String(bus.feature || "").trim() || null,
    type: String(bus.type || "").trim() || null
  };
}

function normalizeNextBus(nextBus, visitNumber) {
  if (!nextBus?.EstimatedArrival) {
    return null;
  }

  const estimatedArrival = new Date(nextBus.EstimatedArrival);
  const rawMinutes = Math.round((estimatedArrival.getTime() - Date.now()) / 60000);

  return {
    estimatedArrival: estimatedArrival.toISOString(),
    minutes: Math.max(rawMinutes, 0),
    visitNumber: nextBus.VisitNumber || visitNumber,
    lat:
      Number.isFinite(Number(nextBus.Latitude)) && Number(nextBus.Latitude) > 0
        ? Number(nextBus.Latitude)
        : null,
    lng:
      Number.isFinite(Number(nextBus.Longitude)) && Number(nextBus.Longitude) > 0
        ? Number(nextBus.Longitude)
        : null,
    crowdLevel: normalizePublicBusCrowdLevel(nextBus.Load),
    feature: String(nextBus.Feature || "").trim() || null,
    type: String(nextBus.Type || "").trim() || null
  };
}

async function fetchCampusOmnibusVehicles(serviceNo) {
  if (!CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo]) {
    throw new ApiError(500, `No NTU Omnibus mapping is defined for ${serviceNo}.`);
  }

  return fetchNtuOmnibusJson(
    "/screenservices/CampusShuttle_MUI/MainFlow/RenderMap/DataActionGetActiveBusServicesData",
    NTU_OMNIBUS_API.activeBusServicesData,
    buildCampusOmnibusRoutePayload(serviceNo)
  );
}

function buildCampusOmnibusRoutePayload(serviceNo) {
  const routeConfig = CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo];

  return {
    screenData: {
      variables: {
        RouteId: routeConfig.routeName,
        IsSBS_Route: false,
        CurrDateTime_Local: formatSingaporeDateTime(new Date()),
        RouteColorCode: routeConfig.routeColorCode,
        RouteName: routeConfig.routeName,
        UserCurrLat: String(NTU_VIEW.center.lat),
        _userCurrLatInDataFetchStatus: 1,
        UserCurrLng: String(NTU_VIEW.center.lng),
        _userCurrLngInDataFetchStatus: 1,
        CurrDateTime: "1900-01-01T00:00:00",
        _currDateTimeInDataFetchStatus: 1,
        CheckIsScreenActive: true,
        _checkIsScreenActiveInDataFetchStatus: 1,
        IsRenderMapActive: true,
        _isRenderMapActiveInDataFetchStatus: 1
      }
    },
    clientVariables: {
      ...NTU_OMNIBUS_CLIENT_VARIABLES,
      SelectedRoute: routeConfig.routeName
    }
  };
}

async function fetchNtuOmnibusJson(pathname, apiVersion, body, { retry = true } = {}) {
  const moduleVersion = await getNtuOmnibusModuleVersion();
  let response;

  try {
    response = await fetch(resolveNtuOmnibusUrl(pathname), {
      method: "POST",
      headers: NTU_OMNIBUS_HEADERS,
      body: JSON.stringify({
        versionInfo: {
          moduleVersion,
          apiVersion
        },
        viewName: "MapFlow.Shuttle",
        ...body
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "NTU Omnibus took too long to respond.");
    }

    throw new ApiError(502, "The app could not reach NTU Omnibus right now.", String(error));
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new ApiError(
      502,
      "NTU Omnibus could not fulfil the campus shuttle request right now.",
      detail.slice(0, 300)
    );
  }

  const payload = await response.json();
  const versionInfo = payload?.versionInfo || {};

  if (retry && (versionInfo.hasModuleVersionChanged || versionInfo.hasApiVersionChanged)) {
    ntuOmnibusModuleVersionCache.value = null;
    ntuOmnibusModuleVersionCache.fetchedAt = 0;
    return fetchNtuOmnibusJson(pathname, apiVersion, body, {
      retry: false
    });
  }

  return payload;
}

async function getNtuOmnibusModuleVersion() {
  const cacheAge = Date.now() - ntuOmnibusModuleVersionCache.fetchedAt;

  if (ntuOmnibusModuleVersionCache.value && cacheAge < NTU_OMNIBUS_MODULE_VERSION_TTL_MS) {
    return ntuOmnibusModuleVersionCache.value;
  }

  if (ntuOmnibusModuleVersionCache.pending) {
    return ntuOmnibusModuleVersionCache.pending;
  }

  ntuOmnibusModuleVersionCache.pending = fetchNtuOmnibusModuleVersion()
    .then((moduleVersion) => {
      ntuOmnibusModuleVersionCache.value = moduleVersion;
      ntuOmnibusModuleVersionCache.fetchedAt = Date.now();
      return moduleVersion;
    })
    .finally(() => {
      ntuOmnibusModuleVersionCache.pending = null;
    });

  return ntuOmnibusModuleVersionCache.pending;
}

async function fetchNtuOmnibusModuleVersion() {
  const url = resolveNtuOmnibusUrl("moduleservices/moduleversioninfo?491u8Vf4gA2M4H1K39PJrQ");
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "NTU Omnibus version metadata took too long to respond.");
    }

    throw new ApiError(502, "NTU Omnibus version metadata could not be reached.", String(error));
  }

  if (!response.ok) {
    throw new ApiError(502, "NTU Omnibus version metadata could not be loaded.");
  }

  const payload = await response.json();
  const moduleVersion = String(payload?.versionToken || "").trim();

  if (!moduleVersion) {
    throw new ApiError(502, "NTU Omnibus did not return a module version token.");
  }

  return moduleVersion;
}

function resolveNtuOmnibusUrl(pathname) {
  return new URL(String(pathname).replace(/^\/+/, ""), NTU_OMNIBUS_BASE_URL);
}

function formatSingaporeDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${lookup.day}-${lookup.month}-${lookup.year} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

async function fetchDatamallJson(pathname, query = {}) {
  const url = new URL(`${LTA_BASE_URL}${pathname}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  let response;

  try {
    response = await fetch(url, {
      headers: {
        AccountKey: LTA_ACCOUNT_KEY,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "LTA DataMall took too long to respond.");
    }

    throw new ApiError(502, "The app could not reach LTA DataMall right now.", String(error));
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(
      response.status,
      "LTA DataMall could not fulfil the request right now.",
      body.slice(0, 300)
    );
  }

  return response.json();
}

async function fetchArriveLahJson(busStopCode) {
  const url = new URL(ARRIVELAH_BASE_URL);
  url.searchParams.set("id", busStopCode);

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "ArriveLah took too long to respond.");
    }

    throw new ApiError(502, "The app could not reach ArriveLah right now.", String(error));
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, "ArriveLah could not fulfil the request right now.", body.slice(0, 300));
  }

  return response.json();
}

async function fetchPublicJson(url) {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "The public fallback dataset took too long to respond.");
    }

    throw new ApiError(502, "The public fallback dataset could not be reached.", String(error));
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      "The public fallback dataset could not be loaded right now.",
      `${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

function decodePolyline(encodedPath) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encodedPath.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      byte = encodedPath.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;

    do {
      byte = encodedPath.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates;
}

function normalizeLtaAccountKey(value) {
  const normalized = String(value || "").trim();

  if (!normalized || normalized === "replace-with-your-datamall-account-key") {
    return null;
  }

  return normalized;
}

function publicRouteDataset(dataset) {
  const { stopLookup, ...publicDataset } = dataset;
  return publicDataset;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = [];

  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(iteratee));
    results.push(...batchResults);
  }

  return results;
}

function getDistanceMeters(startLat, startLng, endLat, endLng) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(endLat - startLat);
  const deltaLng = toRadians(endLng - startLng);
  const startLatRadians = toRadians(startLat);
  const endLatRadians = toRadians(endLat);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLatRadians) * Math.cos(endLatRadians) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMeters * c;
}

function handleApiError(res, error) {
  const status = error instanceof ApiError ? error.status : 500;
  const message =
    error instanceof ApiError
      ? error.message
      : "Something unexpected happened while loading NTU transport data.";

  res.status(status).json({
    error: message,
    detail: error instanceof ApiError ? error.detail : String(error)
  });
}

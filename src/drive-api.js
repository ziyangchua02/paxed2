import * as svy21 from "svy21";

const SG_CENTER = {
  lat: 1.3483,
  lng: 103.6831
};

const DATAGOV_CARPARK_AVAILABILITY_URL = "https://api.data.gov.sg/v1/transport/carpark-availability";
const DATAGOV_DATASTORE_SEARCH_URL = "https://data.gov.sg/api/action/datastore_search";
const HDB_CARPARK_RESOURCE_ID = "d_23f946fa557947f93a8043bbef41dd09";

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);
const DRIVE_METADATA_CACHE_TTL_MS = Number(
  process.env.DRIVE_METADATA_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
const DRIVE_AVAILABILITY_CACHE_TTL_MS = Number(
  process.env.DRIVE_AVAILABILITY_CACHE_TTL_MS || 25_000
);
const DRIVE_DEFAULT_RADIUS_METERS = Number(process.env.DRIVE_DEFAULT_RADIUS_METERS || 2500);
const DRIVE_DEFAULT_LIMIT = Number(process.env.DRIVE_DEFAULT_LIMIT || 120);
const DRIVE_MAX_LIMIT = 220;
const DRIVE_RADIUS_EXPANSION_STEPS = [4_000, 6_000, 9_000, 12_000, 16_000, 20_000];
const HDB_CARPARK_PAGE_SIZE = Number(process.env.HDB_CARPARK_PAGE_SIZE || 3000);
const DRIVE_UPSTREAM_RETRY_COUNT = Number(process.env.DRIVE_UPSTREAM_RETRY_COUNT || 2);
const DRIVE_UPSTREAM_RETRY_DELAY_MS = Number(process.env.DRIVE_UPSTREAM_RETRY_DELAY_MS || 350);

const carparkMetadataCache = {
  value: null,
  fetchedAt: 0,
  pending: null
};

const carparkAvailabilityCache = {
  value: null,
  fetchedAt: 0,
  pending: null
};

class DriveApiError extends Error {
  constructor(status, message, detail = "") {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
    this.detail = detail;
  }
}

export function registerDriveApiRoutes(app) {
  app.get("/api/drive/health", (_req, res) => {
    res.json({
      ok: true,
      country: "SG",
      center: SG_CENTER,
      provider: "data.gov.sg",
      defaults: {
        radiusMeters: DRIVE_DEFAULT_RADIUS_METERS,
        limit: DRIVE_DEFAULT_LIMIT
      }
    });
  });

  app.get("/api/drive/carparks", async (req, res) => {
    try {
      const referenceLat = parseQueryFloat(req.query.lat, SG_CENTER.lat);
      const referenceLng = parseQueryFloat(req.query.lng, SG_CENTER.lng);
      const requestedRadiusMeters = clampNumber(
        parseQueryFloat(req.query.radius, DRIVE_DEFAULT_RADIUS_METERS),
        300,
        12_000
      );
      const limit = Math.round(
        clampNumber(parseQueryFloat(req.query.limit, DRIVE_DEFAULT_LIMIT), 1, DRIVE_MAX_LIMIT)
      );

      const metadata = await getCarparkMetadata();
      const availabilityPayload = await getCarparkAvailability().catch((error) => {
        console.warn("Drive availability data could not be loaded.", error);

        return {
          updatedAt: new Date().toISOString(),
          byCarparkNo: new Map()
        };
      });

      const sortedCarparks = metadata
        .map((carpark) => {
          const distanceMeters = getDistanceMeters(
            referenceLat,
            referenceLng,
            carpark.lat,
            carpark.lng
          );

          const liveAvailability = availabilityPayload.byCarparkNo.get(carpark.carparkNo) || null;
          const pricing = deriveParkingPrice(carpark);

          return {
            ...carpark,
            distanceMeters,
            availability: liveAvailability,
            priceLabel: pricing.label,
            priceNotes: pricing.notes
          };
        })
        .sort((left, right) => left.distanceMeters - right.distanceMeters);

      const withinRequestedRadiusCarparks = sortedCarparks.filter(
        (carpark) => carpark.distanceMeters <= requestedRadiusMeters
      );

      let effectiveRadiusMeters = requestedRadiusMeters;
      let nearbyCarparks = withinRequestedRadiusCarparks;
      let searchMode = "within-radius";

      if (!nearbyCarparks.length) {
        for (const radiusStep of DRIVE_RADIUS_EXPANSION_STEPS) {
          if (radiusStep <= effectiveRadiusMeters) {
            continue;
          }

          const candidates = sortedCarparks.filter(
            (carpark) => carpark.distanceMeters <= radiusStep
          );

          if (!candidates.length) {
            continue;
          }

          effectiveRadiusMeters = radiusStep;
          nearbyCarparks = candidates;
          searchMode = "radius-expanded";
          break;
        }
      }

      if (!nearbyCarparks.length) {
        searchMode = "nearest-fallback";
      }

      const selectedCarparks = (nearbyCarparks.length ? nearbyCarparks : sortedCarparks).slice(0, limit);

      res.json({
        updatedAt: availabilityPayload.updatedAt,
        center: {
          lat: referenceLat,
          lng: referenceLng
        },
        requestedRadiusMeters,
        radiusMeters: effectiveRadiusMeters,
        limit,
        searchMode,
        withinRadiusCount: withinRequestedRadiusCarparks.length,
        count: selectedCarparks.length,
        carparks: selectedCarparks
      });
    } catch (error) {
      handleDriveApiError(res, error);
    }
  });
}

async function getCarparkMetadata() {
  const cacheAge = Date.now() - carparkMetadataCache.fetchedAt;

  if (Array.isArray(carparkMetadataCache.value) && cacheAge < DRIVE_METADATA_CACHE_TTL_MS) {
    return carparkMetadataCache.value;
  }

  if (carparkMetadataCache.pending) {
    return carparkMetadataCache.pending;
  }

  carparkMetadataCache.pending = fetchCarparkMetadata()
    .then((metadata) => {
      carparkMetadataCache.value = metadata;
      carparkMetadataCache.fetchedAt = Date.now();
      return metadata;
    })
    .catch((error) => {
      if (Array.isArray(carparkMetadataCache.value) && carparkMetadataCache.value.length) {
        console.warn("Drive metadata refresh failed; serving stale metadata cache.", error);
        return carparkMetadataCache.value;
      }

      throw error;
    })
    .finally(() => {
      carparkMetadataCache.pending = null;
    });

  return carparkMetadataCache.pending;
}

async function fetchCarparkMetadata() {
  const pageSize = clampNumber(HDB_CARPARK_PAGE_SIZE, 500, 5000);
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  const allRecords = [];

  while (offset < total) {
    const requestUrl = new URL(DATAGOV_DATASTORE_SEARCH_URL);
    requestUrl.searchParams.set("resource_id", HDB_CARPARK_RESOURCE_ID);
    requestUrl.searchParams.set("limit", String(pageSize));
    requestUrl.searchParams.set("offset", String(offset));

    let payload;

    try {
      payload = await fetchJsonWithRetry(requestUrl.toString());
    } catch (error) {
      if (allRecords.length) {
        console.warn("Drive metadata paging failed; using partial metadata payload.", error);
        break;
      }

      throw error;
    }

    if (!payload?.success) {
      throw new DriveApiError(502, "Carpark metadata could not be loaded right now.");
    }

    const result = payload.result || {};
    const records = Array.isArray(result.records) ? result.records : [];

    total = Number.isFinite(Number(result.total)) ? Number(result.total) : records.length;
    allRecords.push(...records);
    offset += records.length;

    if (!records.length || records.length < pageSize) {
      break;
    }
  }

  const dedupedByCarparkNo = new Map();

  for (const record of allRecords) {
    const normalized = normalizeCarparkMetadata(record);

    if (!normalized || dedupedByCarparkNo.has(normalized.carparkNo)) {
      continue;
    }

    dedupedByCarparkNo.set(normalized.carparkNo, normalized);
  }

  const normalizedRecords = Array.from(dedupedByCarparkNo.values());

  if (!normalizedRecords.length) {
    throw new DriveApiError(502, "Carpark metadata dataset is currently empty.");
  }

  return normalizedRecords;
}

function normalizeCarparkMetadata(record) {
  const carparkNo = String(record?.car_park_no || "").trim();

  if (!carparkNo) {
    return null;
  }

  const xCoord = Number(record?.x_coord);
  const yCoord = Number(record?.y_coord);

  if (!Number.isFinite(xCoord) || !Number.isFinite(yCoord)) {
    return null;
  }

  const convertedCoordinates = convertSvy21Coordinates(xCoord, yCoord);
  const lat = Number(convertedCoordinates?.lat);
  const lng = Number(convertedCoordinates?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    carparkNo,
    address: String(record?.address || carparkNo).trim(),
    lat,
    lng,
    carparkType: String(record?.car_park_type || "Carpark").trim() || "Carpark",
    parkingSystem:
      String(record?.type_of_parking_system || "Unknown system").trim() || "Unknown system",
    shortTermParking: String(record?.short_term_parking || "Unknown").trim() || "Unknown",
    freeParking: String(record?.free_parking || "NO").trim() || "NO",
    nightParking: String(record?.night_parking || "Unknown").trim() || "Unknown",
    decks: toSafeInteger(record?.car_park_decks),
    gantryHeight: String(record?.gantry_height || "").trim() || null,
    basement: String(record?.car_park_basement || "N").trim().toUpperCase() === "Y"
  };
}

function convertSvy21Coordinates(easting, northing) {
  // HDB carpark metadata uses x_coord as Easting and y_coord as Northing.
  const preferred = toLatLngTuple(svy21.svy21ToWgs84(northing, easting));
  const fallback = toLatLngTuple(svy21.svy21ToWgs84(easting, northing));

  const preferredIsInSingapore = isLikelySingaporeCoordinate(preferred);
  const fallbackIsInSingapore = isLikelySingaporeCoordinate(fallback);

  if (preferredIsInSingapore) {
    return preferred;
  }

  if (fallbackIsInSingapore) {
    return fallback;
  }

  return preferred;
}

function toLatLngTuple(tuple) {
  return {
    lat: Number(tuple?.[0]),
    lng: Number(tuple?.[1])
  };
}

function isLikelySingaporeCoordinate(coordinate) {
  return (
    Number.isFinite(coordinate?.lat) &&
    Number.isFinite(coordinate?.lng) &&
    coordinate.lat >= 1.15 &&
    coordinate.lat <= 1.5 &&
    coordinate.lng >= 103.55 &&
    coordinate.lng <= 104.1
  );
}

async function getCarparkAvailability() {
  const cacheAge = Date.now() - carparkAvailabilityCache.fetchedAt;

  if (
    carparkAvailabilityCache.value &&
    cacheAge < DRIVE_AVAILABILITY_CACHE_TTL_MS
  ) {
    return carparkAvailabilityCache.value;
  }

  if (carparkAvailabilityCache.pending) {
    return carparkAvailabilityCache.pending;
  }

  carparkAvailabilityCache.pending = fetchCarparkAvailability()
    .then((availabilityPayload) => {
      carparkAvailabilityCache.value = availabilityPayload;
      carparkAvailabilityCache.fetchedAt = Date.now();
      return availabilityPayload;
    })
    .catch((error) => {
      if (carparkAvailabilityCache.value) {
        console.warn("Drive availability refresh failed; serving stale availability cache.", error);
        return carparkAvailabilityCache.value;
      }

      throw error;
    })
    .finally(() => {
      carparkAvailabilityCache.pending = null;
    });

  return carparkAvailabilityCache.pending;
}

async function fetchCarparkAvailability() {
  const payload = await fetchJsonWithRetry(DATAGOV_CARPARK_AVAILABILITY_URL);
  const snapshot = Array.isArray(payload?.items) ? payload.items[0] : null;
  const carparkData = Array.isArray(snapshot?.carpark_data) ? snapshot.carpark_data : [];
  const byCarparkNo = new Map();

  for (const entry of carparkData) {
    const carparkNo = String(entry?.carpark_number || "").trim();

    if (!carparkNo) {
      continue;
    }

    const lotInfoCandidates = Array.isArray(entry?.carpark_info) ? entry.carpark_info : [];
    const carLotInfo =
      lotInfoCandidates.find((lotInfo) => String(lotInfo?.lot_type || "").toUpperCase() === "C") ||
      lotInfoCandidates[0] ||
      null;

    if (!carLotInfo) {
      continue;
    }

    byCarparkNo.set(carparkNo, {
      totalLots: toSafeInteger(carLotInfo.total_lots),
      availableLots: toSafeInteger(carLotInfo.lots_available),
      lotType: String(carLotInfo.lot_type || "C").trim() || "C",
      updatedAt: String(entry?.update_datetime || snapshot?.timestamp || "").trim() || null
    });
  }

  return {
    updatedAt: String(snapshot?.timestamp || new Date().toISOString()),
    byCarparkNo
  };
}

function deriveParkingPrice(carpark) {
  const shortTermPolicy = normalizePolicyValue(carpark.shortTermParking);
  const freeParkingPolicy = normalizePolicyValue(carpark.freeParking);

  if (shortTermPolicy === "NO") {
    return {
      label: "No short-term parking",
      notes: "Season parking only. Verify on-site signage before entering."
    };
  }

  const baseRateLabel = "$0.60 per 30 mins (est.)";
  const shortTermNotes =
    shortTermPolicy === "WHOLE DAY"
      ? "Short-term parking: Whole day."
      : `Short-term parking: ${carpark.shortTermParking}.`;
  const freeParkingNotes =
    freeParkingPolicy === "NO"
      ? "No listed free parking window."
      : `Free parking: ${carpark.freeParking}.`;

  return {
    label: baseRateLabel,
    notes: `${shortTermNotes} ${freeParkingNotes} Rates are estimated; confirm at signage or parking.sg.`
  };
}

function normalizePolicyValue(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function parseQueryFloat(value, fallbackValue) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
}

function clampNumber(value, minimum, maximum) {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(Math.max(value, minimum), maximum);
}

function toSafeInteger(value) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getDistanceMeters(startLat, startLng, endLat, endLng) {
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(endLat - startLat);
  const deltaLng = toRadians(endLng - startLng);
  const lat1 = toRadians(startLat);
  const lat2 = toRadians(endLat);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

async function fetchJsonWithTimeout(url) {
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
      throw new DriveApiError(504, "Drive data source took too long to respond.");
    }

    throw new DriveApiError(502, "Drive data source could not be reached.", String(error));
  }

  if (!response.ok) {
    const detail = await response.text();

    throw new DriveApiError(
      502,
      "Drive data source returned an unsuccessful response.",
      detail.slice(0, 300)
    );
  }

  return response.json();
}

async function fetchJsonWithRetry(url) {
  const retryCount = Math.max(0, Math.floor(DRIVE_UPSTREAM_RETRY_COUNT));
  const maxAttempts = retryCount + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url);
    } catch (error) {
      const isRetryable =
        error instanceof DriveApiError ? error.status >= 500 : true;

      if (!isRetryable || attempt >= maxAttempts) {
        throw error;
      }

      const backoffMs = DRIVE_UPSTREAM_RETRY_DELAY_MS * attempt;
      await sleep(backoffMs);
    }
  }

  throw new DriveApiError(502, "Drive data source could not be reached.");
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function handleDriveApiError(response, error) {
  const status = error instanceof DriveApiError ? error.status : 500;
  const message =
    error instanceof DriveApiError
      ? error.message
      : "Drive dashboard data could not be loaded right now.";

  response.status(status).json({
    error: message,
    detail: error instanceof DriveApiError ? error.detail : String(error)
  });
}

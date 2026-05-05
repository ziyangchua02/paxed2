const SG_DEFAULT_CENTER = {
  lat: 1.3483,
  lng: 103.6831
};

const DATAGOV_ENVIRONMENT_BASE_URL = "https://api.data.gov.sg/v1/environment";
const GOOGLE_WEATHER_BASE_URL = "https://weather.googleapis.com/v1";
const OPEN_METEO_FORECAST_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const GOOGLE_WEATHER_ENDPOINTS = {
  currentConditions: "currentConditions:lookup",
  hourlyForecast: "forecast/hours:lookup",
  dailyForecast: "forecast/days:lookup"
};
const WEATHER_ENDPOINTS = {
  twoHourForecast: `${DATAGOV_ENVIRONMENT_BASE_URL}/2-hour-weather-forecast`,
  twentyFourHourForecast: `${DATAGOV_ENVIRONMENT_BASE_URL}/24-hour-weather-forecast`,
  fourDayForecast: `${DATAGOV_ENVIRONMENT_BASE_URL}/4-day-weather-forecast`,
  temperature: `${DATAGOV_ENVIRONMENT_BASE_URL}/air-temperature`,
  humidity: `${DATAGOV_ENVIRONMENT_BASE_URL}/relative-humidity`,
  rainfall: `${DATAGOV_ENVIRONMENT_BASE_URL}/rainfall`,
  windSpeed: `${DATAGOV_ENVIRONMENT_BASE_URL}/wind-speed`,
  uvIndex: `${DATAGOV_ENVIRONMENT_BASE_URL}/uv-index`
};

const WEATHER_SOURCE_CONFIG = [
  {
    key: "twoHourForecast",
    label: "2-hour forecast"
  },
  {
    key: "twentyFourHourForecast",
    label: "24-hour forecast"
  },
  {
    key: "fourDayForecast",
    label: "4-day forecast"
  },
  {
    key: "temperature",
    label: "temperature"
  },
  {
    key: "humidity",
    label: "relative humidity"
  },
  {
    key: "rainfall",
    label: "rainfall"
  },
  {
    key: "windSpeed",
    label: "wind speed"
  },
  {
    key: "uvIndex",
    label: "UV index"
  }
];

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);
const WEATHER_CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_MS || 45_000);
const WEATHER_UV_FALLBACK_CACHE_TTL_MS = Number(process.env.WEATHER_UV_FALLBACK_CACHE_TTL_MS || 300_000);
const WEATHER_GOOGLE_CACHE_TTL_MS = Number(process.env.WEATHER_GOOGLE_CACHE_TTL_MS || 90_000);
const WEATHER_MAX_RADIUS_METERS = 40_000;
const GOOGLE_WEATHER_HOURS_LOOKAHEAD = clampPositiveInteger(
  Number(process.env.GOOGLE_WEATHER_HOURS_LOOKAHEAD || 24),
  24,
  240
);
const GOOGLE_WEATHER_DAYS_LOOKAHEAD = clampPositiveInteger(
  Number(process.env.GOOGLE_WEATHER_DAYS_LOOKAHEAD || 4),
  4,
  10
);
const GOOGLE_WEATHER_API_KEY = String(
  process.env.GOOGLE_WEATHER_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GMAPS_API_KEY ||
    process.env.GMPAS_API_KEY ||
    process.env.MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_WEATHER_DEMO_KEY ||
    process.env.MAPS_DEMO_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    ""
).trim();

const weatherPayloadCache = {
  twoHourForecast: createCacheEntry(),
  twentyFourHourForecast: createCacheEntry(),
  fourDayForecast: createCacheEntry(),
  temperature: createCacheEntry(),
  humidity: createCacheEntry(),
  rainfall: createCacheEntry(),
  windSpeed: createCacheEntry(),
  uvIndex: createCacheEntry()
};
const weatherUvFallbackCache = new Map();
const weatherGoogleSummaryCache = new Map();

class WeatherApiError extends Error {
  constructor(status, message, detail = "") {
    super(message);
    this.name = "WeatherApiError";
    this.status = status;
    this.detail = detail;
  }
}

export function registerWeatherApiRoutes(app) {
  app.get("/api/weather/health", (_req, res) => {
    res.json({
      ok: true,
      country: "SG",
      provider: isGoogleWeatherEnabled()
        ? "google-weather-primary,data.gov.sg-fallback"
        : "data.gov.sg",
      defaults: {
        center: SG_DEFAULT_CENTER,
        cacheTtlMs: WEATHER_CACHE_TTL_MS,
        googleWeatherEnabled: isGoogleWeatherEnabled()
      }
    });
  });

  app.get("/api/weather/summary", async (req, res) => {
    try {
      const requestedCenter = {
        lat: parseQueryFloat(req.query.lat, SG_DEFAULT_CENTER.lat),
        lng: parseQueryFloat(req.query.lng, SG_DEFAULT_CENTER.lng)
      };
      let googleFallbackWarning = "";

      if (isGoogleWeatherEnabled()) {
        try {
          const googleWeatherSummary = await getCachedGoogleWeatherSummary(requestedCenter);
          res.json(googleWeatherSummary);
          return;
        } catch (googleWeatherError) {
          googleFallbackWarning =
            "Google Weather feed is temporarily unavailable. Showing data.gov.sg snapshot.";
          console.warn("Google Weather source unavailable for summary payload.", {
            source: "google-weather",
            reason: String(googleWeatherError || "Unknown error")
          });
        }
      }

      const fallbackUvPromise = getCachedBackupUvIndexSummary(requestedCenter);

      const payloadResults = await Promise.allSettled(
        WEATHER_SOURCE_CONFIG.map((source) =>
          getCachedPayload(source.key, WEATHER_ENDPOINTS[source.key])
        )
      );
      const fallbackUvResult = await Promise.allSettled([fallbackUvPromise]);
      const fallbackUvSummary =
        fallbackUvResult[0]?.status === "fulfilled" ? fallbackUvResult[0].value : null;

      const weatherPayloadByKey = Object.create(null);
      const warnings = googleFallbackWarning ? [googleFallbackWarning] : [];

      for (const [index, source] of WEATHER_SOURCE_CONFIG.entries()) {
        const result = payloadResults[index];

        if (result?.status === "fulfilled") {
          weatherPayloadByKey[source.key] = result.value;
          continue;
        }

        if (source.key !== "uvIndex") {
          warnings.push(`${source.label} feed is temporarily unavailable.`);
        }
        weatherPayloadByKey[source.key] = null;

        console.warn("Weather source unavailable for summary payload.", {
          source: source.key,
          reason: String(result?.reason || "Unknown error")
        });
      }

      if (fallbackUvResult[0]?.status === "rejected") {
        console.warn("Backup UV source unavailable for summary payload.", {
          source: "open-meteo",
          reason: String(fallbackUvResult[0].reason || "Unknown error")
        });
      }

      const twoHourForecastPayload = weatherPayloadByKey.twoHourForecast;
      const twentyFourHourForecastPayload = weatherPayloadByKey.twentyFourHourForecast;
      const fourDayForecastPayload = weatherPayloadByKey.fourDayForecast;
      const temperaturePayload = weatherPayloadByKey.temperature;
      const humidityPayload = weatherPayloadByKey.humidity;
      const rainfallPayload = weatherPayloadByKey.rainfall;
      const windSpeedPayload = weatherPayloadByKey.windSpeed;
      const uvIndexPayload = weatherPayloadByKey.uvIndex;

      const forecastSummary = buildForecastSummary(twoHourForecastPayload, requestedCenter);
      const forecast24h = buildTwentyFourHourForecastSummary(twentyFourHourForecastPayload);
      const forecast4d = buildFourDayForecastSummary(fourDayForecastPayload);
      const metrics = {
        temperatureC: buildStationMetricSummary(
          temperaturePayload,
          requestedCenter,
          "Air temperature",
          "°C",
          1
        ),
        humidityPct: buildStationMetricSummary(
          humidityPayload,
          requestedCenter,
          "Relative humidity",
          "%",
          1
        ),
        rainfallMm: buildStationMetricSummary(
          rainfallPayload,
          requestedCenter,
          "Rainfall",
          "mm",
          2
        ),
        windSpeedMs: buildStationMetricSummary(
          windSpeedPayload,
          requestedCenter,
          "Wind speed",
          "m/s",
          1
        ),
        uvIndex: buildUvIndexMetricSummary(uvIndexPayload, fallbackUvSummary)
      };

      if (metrics.uvIndex?.source === "open-meteo") {
        warnings.push("Primary UV feed is delayed. Showing backup UV estimate.");
      } else if (metrics.uvIndex?.source === "estimated-model") {
        warnings.push("UV live feeds are delayed. Showing modeled UV estimate.");
      } else if (!metrics.uvIndex?.source) {
        warnings.push("UV index feeds are temporarily unavailable.");
      }

      const updatedAtCandidates = [
        forecastSummary.updatedAt,
        forecast24h.updatedAt,
        forecast4d.updatedAt,
        metrics.temperatureC?.updatedAt,
        metrics.humidityPct?.updatedAt,
        metrics.rainfallMm?.updatedAt,
        metrics.windSpeedMs?.updatedAt,
        metrics.uvIndex?.updatedAt
      ].filter(Boolean);

      res.json({
        source: "data.gov.sg",
        country: "SG",
        center: requestedCenter,
        updatedAt: updatedAtCandidates.sort().at(-1) || new Date().toISOString(),
        partial: warnings.length > 0,
        warnings,
        validPeriod: forecastSummary.validPeriod,
        overview: forecastSummary.overview,
        conditionBreakdown: forecastSummary.conditionBreakdown,
        conditions: forecastSummary.conditions,
        forecast24h,
        forecast4d,
        metrics
      });
    } catch (error) {
      handleWeatherApiError(res, error);
    }
  });
}

function createCacheEntry() {
  return {
    value: null,
    fetchedAt: 0,
    pending: null
  };
}

function isGoogleWeatherEnabled() {
  return Boolean(GOOGLE_WEATHER_API_KEY);
}

function clampPositiveInteger(value, fallbackValue, maxValue = Number.POSITIVE_INFINITY) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.min(Math.max(Math.round(parsedValue), 1), maxValue);
}

function getLocationCacheKey(requestedCenter) {
  const latitude = parseFiniteNumber(requestedCenter?.lat);
  const longitude = parseFiniteNumber(requestedCenter?.lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return `${SG_DEFAULT_CENTER.lat.toFixed(2)},${SG_DEFAULT_CENTER.lng.toFixed(2)}`;
  }

  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

function buildGoogleWeatherEndpointUrl(endpointPath, requestedCenter, extraParams = {}) {
  const latitude = parseFiniteNumber(requestedCenter?.lat) ?? SG_DEFAULT_CENTER.lat;
  const longitude = parseFiniteNumber(requestedCenter?.lng) ?? SG_DEFAULT_CENTER.lng;
  const searchParams = new URLSearchParams({
    key: GOOGLE_WEATHER_API_KEY,
    "location.latitude": latitude.toFixed(6),
    "location.longitude": longitude.toFixed(6),
    unitsSystem: "METRIC",
    languageCode: "en"
  });

  for (const [paramKey, rawValue] of Object.entries(extraParams)) {
    if (rawValue == null || rawValue === "") {
      continue;
    }

    searchParams.set(paramKey, String(rawValue));
  }

  return `${GOOGLE_WEATHER_BASE_URL}/${endpointPath}?${searchParams.toString()}`;
}

async function getCachedGoogleWeatherSummary(requestedCenter) {
  if (!isGoogleWeatherEnabled()) {
    throw new WeatherApiError(
      503,
      "Google Weather API key is missing. Set GOOGLE_WEATHER_API_KEY, GOOGLE_MAPS_API_KEY, GMAPS_API_KEY, or MAPS_API_KEY."
    );
  }

  const cacheKey = getLocationCacheKey(requestedCenter);
  let cacheEntry = weatherGoogleSummaryCache.get(cacheKey);

  if (!cacheEntry) {
    cacheEntry = createCacheEntry();
    weatherGoogleSummaryCache.set(cacheKey, cacheEntry);
  }

  const cacheAge = Date.now() - cacheEntry.fetchedAt;

  if (cacheEntry.value && cacheAge < WEATHER_GOOGLE_CACHE_TTL_MS) {
    return cacheEntry.value;
  }

  if (cacheEntry.pending) {
    return cacheEntry.pending;
  }

  cacheEntry.pending = fetchGoogleWeatherSummary(requestedCenter)
    .then((summary) => {
      cacheEntry.value = summary;
      cacheEntry.fetchedAt = Date.now();
      return summary;
    })
    .catch((error) => {
      if (cacheEntry.value) {
        console.warn("Google Weather refresh failed; serving stale weather cache.", error);
        return cacheEntry.value;
      }

      throw error;
    })
    .finally(() => {
      cacheEntry.pending = null;
    });

  return cacheEntry.pending;
}

async function fetchGoogleWeatherSummary(requestedCenter) {
  const currentConditionsUrl = buildGoogleWeatherEndpointUrl(
    GOOGLE_WEATHER_ENDPOINTS.currentConditions,
    requestedCenter
  );
  const hourlyForecastUrl = buildGoogleWeatherEndpointUrl(
    GOOGLE_WEATHER_ENDPOINTS.hourlyForecast,
    requestedCenter,
    {
      hours: GOOGLE_WEATHER_HOURS_LOOKAHEAD,
      pageSize: GOOGLE_WEATHER_HOURS_LOOKAHEAD
    }
  );
  const dailyForecastUrl = buildGoogleWeatherEndpointUrl(
    GOOGLE_WEATHER_ENDPOINTS.dailyForecast,
    requestedCenter,
    {
      days: GOOGLE_WEATHER_DAYS_LOOKAHEAD,
      pageSize: GOOGLE_WEATHER_DAYS_LOOKAHEAD
    }
  );

  const [currentResult, hourlyResult, dailyResult] = await Promise.allSettled([
    fetchJsonWithTimeout(currentConditionsUrl),
    fetchJsonWithTimeout(hourlyForecastUrl),
    fetchJsonWithTimeout(dailyForecastUrl)
  ]);

  if (currentResult.status !== "fulfilled" || hourlyResult.status !== "fulfilled") {
    throw new WeatherApiError(502, "Google Weather API returned incomplete forecast data.");
  }

  const warnings = [];

  if (dailyResult.status !== "fulfilled") {
    warnings.push("4-day forecast is temporarily unavailable from Google Weather.");
  }

  return buildGoogleWeatherSummary(
    currentResult.value,
    hourlyResult.value,
    dailyResult.status === "fulfilled" ? dailyResult.value : null,
    requestedCenter,
    warnings
  );
}

function buildGoogleWeatherSummary(
  currentPayload,
  hourlyPayload,
  dailyPayload,
  requestedCenter,
  warnings = []
) {
  const latitude = parseFiniteNumber(requestedCenter?.lat) ?? SG_DEFAULT_CENTER.lat;
  const longitude = parseFiniteNumber(requestedCenter?.lng) ?? SG_DEFAULT_CENTER.lng;
  const updatedAt = String(currentPayload?.currentTime || "").trim() || new Date().toISOString();

  const currentConditionText = normalizeGoogleConditionText(currentPayload?.weatherCondition);
  const currentTemperatureC = parseFiniteNumber(currentPayload?.temperature?.degrees);
  const currentHumidityPct = parseFiniteNumber(currentPayload?.relativeHumidity);
  const currentUvIndex = parseFiniteNumber(currentPayload?.uvIndex);
  const currentRainMm = convertPrecipitationToMillimeters(
    parseFiniteNumber(currentPayload?.precipitation?.qpf?.quantity),
    currentPayload?.precipitation?.qpf?.unit
  );
  const currentWindSpeedKph = convertSpeedToKph(
    parseFiniteNumber(currentPayload?.wind?.speed?.value),
    currentPayload?.wind?.speed?.unit
  );
  const currentWindSpeedMs =
    Number.isFinite(currentWindSpeedKph) ? roundNumber(currentWindSpeedKph / 3.6, 2) : null;
  const currentWindDirection =
    String(currentPayload?.wind?.direction?.cardinal || "").trim() || "Unavailable";

  const hourlyForecastHours = Array.isArray(hourlyPayload?.forecastHours)
    ? hourlyPayload.forecastHours
    : [];
  const hourlyEntries = hourlyForecastHours
    .map((entry) => {
      const windSpeedKph = convertSpeedToKph(
        parseFiniteNumber(entry?.wind?.speed?.value),
        entry?.wind?.speed?.unit
      );

      return {
        startTime: String(entry?.interval?.startTime || "").trim() || null,
        endTime: String(entry?.interval?.endTime || "").trim() || null,
        conditionText: normalizeGoogleConditionText(entry?.weatherCondition),
        temperatureC: parseFiniteNumber(entry?.temperature?.degrees),
        humidityPct: parseFiniteNumber(entry?.relativeHumidity),
        uvIndex: parseFiniteNumber(entry?.uvIndex),
        rainMm: convertPrecipitationToMillimeters(
          parseFiniteNumber(entry?.precipitation?.qpf?.quantity),
          entry?.precipitation?.qpf?.unit
        ),
        precipitationProbabilityPct: parseFiniteNumber(entry?.precipitation?.probability?.percent),
        thunderstormProbabilityPct: parseFiniteNumber(entry?.thunderstormProbability),
        windDirection: String(entry?.wind?.direction?.cardinal || "").trim() || null,
        windSpeedKph: Number.isFinite(windSpeedKph) ? windSpeedKph : null,
        windSpeedMs: Number.isFinite(windSpeedKph) ? windSpeedKph / 3.6 : null
      };
    })
    .filter((entry) => entry.startTime);

  if (!hourlyEntries.length) {
    throw new WeatherApiError(502, "Google Weather hourly forecast is unavailable.");
  }

  const temperatures = hourlyEntries
    .map((entry) => entry.temperatureC)
    .filter((value) => Number.isFinite(value));
  const humidities = hourlyEntries
    .map((entry) => entry.humidityPct)
    .filter((value) => Number.isFinite(value));
  const uvValues = hourlyEntries.map((entry) => entry.uvIndex).filter((value) => Number.isFinite(value));
  const rainfallValues = hourlyEntries
    .map((entry) => entry.rainMm)
    .filter((value) => Number.isFinite(value));
  const windSpeedMsValues = hourlyEntries
    .map((entry) => entry.windSpeedMs)
    .filter((value) => Number.isFinite(value));
  const windSpeedKphValues = hourlyEntries
    .map((entry) => entry.windSpeedKph)
    .filter((value) => Number.isFinite(value));

  if (Number.isFinite(currentTemperatureC)) {
    temperatures.unshift(currentTemperatureC);
  }

  if (Number.isFinite(currentHumidityPct)) {
    humidities.unshift(currentHumidityPct);
  }

  if (Number.isFinite(currentUvIndex)) {
    uvValues.unshift(currentUvIndex);
  }

  if (Number.isFinite(currentRainMm)) {
    rainfallValues.unshift(currentRainMm);
  }

  if (Number.isFinite(currentWindSpeedMs)) {
    windSpeedMsValues.unshift(currentWindSpeedMs);
  }

  if (Number.isFinite(currentWindSpeedKph)) {
    windSpeedKphValues.unshift(currentWindSpeedKph);
  }

  const dominantCondition = getDominantLabel(
    [currentConditionText, ...hourlyEntries.map((entry) => entry.conditionText)],
    currentConditionText
  );
  const rainIndicators = hourlyEntries.filter(
    (entry) =>
      isRainForecast(entry.conditionText) ||
      (Number.isFinite(entry.rainMm) && entry.rainMm > 0.05) ||
      (Number.isFinite(entry.precipitationProbabilityPct) && entry.precipitationProbabilityPct >= 45)
  );
  const thunderIndicators = hourlyEntries.filter(
    (entry) =>
      /thunder/i.test(entry.conditionText) ||
      (Number.isFinite(entry.thunderstormProbabilityPct) && entry.thunderstormProbabilityPct >= 30)
  );

  const validPeriodStart = hourlyEntries[0]?.startTime || updatedAt;
  const validPeriodEnd =
    hourlyEntries.at(-1)?.endTime || hourlyEntries.at(-1)?.startTime || validPeriodStart;
  const windDirection =
    currentWindDirection !== "Unavailable"
      ? currentWindDirection
      : getDominantLabel(
          hourlyEntries.map((entry) => entry.windDirection).filter(Boolean),
          "Unavailable"
        );

  const forecast4d = buildGoogleFourDayForecastSummary(dailyPayload);
  const uvCurrentValue =
    Number.isFinite(currentUvIndex)
      ? currentUvIndex
      : hourlyEntries.find((entry) => Number.isFinite(entry.uvIndex))?.uvIndex ?? null;
  const uvMinValue = uvValues.length ? Math.min(...uvValues) : null;
  const uvMaxValue = uvValues.length ? Math.max(...uvValues) : null;

  return {
    source: "google-weather",
    country: "SG",
    center: {
      lat: latitude,
      lng: longitude
    },
    updatedAt,
    partial: warnings.length > 0,
    warnings,
    validPeriod: {
      start: validPeriodStart,
      end: validPeriodEnd
    },
    overview: {
      totalAreas: 1,
      dominantCondition,
      rainingAreas: rainIndicators.length > 0 ? 1 : 0,
      thunderAreas: thunderIndicators.length > 0 ? 1 : 0
    },
    conditionBreakdown: [
      {
        forecast: dominantCondition,
        areaCount: 1
      }
    ],
    conditions: [
      {
        area: "Selected location",
        forecast: currentConditionText,
        lat: latitude,
        lng: longitude,
        distanceMeters: 0
      }
    ],
    forecast24h: {
      updatedAt,
      validPeriod: {
        start: validPeriodStart,
        end: validPeriodEnd
      },
      generalForecast: dominantCondition,
      temperature: {
        low: temperatures.length ? roundNumber(Math.min(...temperatures), 1) : null,
        high: temperatures.length ? roundNumber(Math.max(...temperatures), 1) : null
      },
      humidity: {
        low: humidities.length ? roundNumber(Math.min(...humidities), 0) : null,
        high: humidities.length ? roundNumber(Math.max(...humidities), 0) : null
      },
      wind: {
        direction: windDirection,
        speedLow: windSpeedKphValues.length ? roundNumber(Math.min(...windSpeedKphValues), 0) : null,
        speedHigh: windSpeedKphValues.length ? roundNumber(Math.max(...windSpeedKphValues), 0) : null
      },
      periods: buildGoogleForecastPeriods(hourlyEntries)
    },
    forecast4d,
    metrics: {
      temperatureC: buildGoogleMetricSummary({
        label: "Air temperature",
        unit: "°C",
        values: temperatures,
        decimalPlaces: 1,
        updatedAt,
        nearestValue: currentTemperatureC
      }),
      humidityPct: buildGoogleMetricSummary({
        label: "Relative humidity",
        unit: "%",
        values: humidities,
        decimalPlaces: 0,
        updatedAt,
        nearestValue: currentHumidityPct
      }),
      rainfallMm: buildGoogleMetricSummary({
        label: "Rainfall",
        unit: "mm",
        values: rainfallValues,
        decimalPlaces: 2,
        updatedAt,
        nearestValue: currentRainMm
      }),
      windSpeedMs: buildGoogleMetricSummary({
        label: "Wind speed",
        unit: "m/s",
        values: windSpeedMsValues,
        decimalPlaces: 1,
        updatedAt,
        nearestValue: currentWindSpeedMs
      }),
      uvIndex: {
        label: "UV index",
        unit: "index",
        current: roundNumber(uvCurrentValue, 1),
        min: Number.isFinite(uvMinValue) ? roundNumber(uvMinValue, 1) : null,
        max: Number.isFinite(uvMaxValue) ? roundNumber(uvMaxValue, 1) : null,
        category: resolveUvCategory(uvCurrentValue),
        updatedAt,
        source: "google-weather"
      }
    }
  };
}

function buildGoogleForecastPeriods(hourlyEntries) {
  if (!hourlyEntries.length) {
    return [];
  }

  const totalEntries = hourlyEntries.length;
  const boundaries = [0, Math.floor(totalEntries / 3), Math.floor((totalEntries * 2) / 3), totalEntries];
  const periods = [];

  for (let index = 0; index < 3; index += 1) {
    const startIndex = boundaries[index];
    const endIndex = boundaries[index + 1];
    const chunk = hourlyEntries.slice(startIndex, endIndex);

    if (!chunk.length) {
      continue;
    }

    const forecast = getDominantLabel(
      chunk.map((entry) => entry.conditionText),
      chunk[0]?.conditionText || "Unavailable"
    );

    periods.push({
      start: chunk[0]?.startTime || null,
      end: chunk.at(-1)?.endTime || chunk.at(-1)?.startTime || null,
      forecast,
      regions: {
        west: forecast,
        east: forecast,
        central: forecast,
        south: forecast,
        north: forecast
      }
    });
  }

  return periods;
}

function buildGoogleFourDayForecastSummary(payload) {
  const forecastDays = Array.isArray(payload?.forecastDays) ? payload.forecastDays.slice(0, 4) : [];
  const forecasts = forecastDays.map((entry) => {
    const date = buildGoogleDisplayDateIso(entry?.displayDate, entry?.interval?.startTime);
    const dateValue = new Date(date || entry?.interval?.startTime || "");
    const dayLabel = Number.isFinite(dateValue.getTime())
      ? dateValue.toLocaleDateString("en-SG", { weekday: "long" })
      : "Unknown";
    const daytimeCondition = normalizeGoogleConditionText(entry?.daytimeForecast?.weatherCondition);
    const nighttimeCondition = normalizeGoogleConditionText(entry?.nighttimeForecast?.weatherCondition);

    return {
      date,
      day: dayLabel,
      forecast: daytimeCondition !== "Unavailable" ? daytimeCondition : nighttimeCondition,
      temperatureLow: parseFiniteNumber(entry?.minTemperature?.degrees),
      temperatureHigh: parseFiniteNumber(entry?.maxTemperature?.degrees)
    };
  });

  return {
    updatedAt: String(forecastDays[0]?.interval?.startTime || "").trim() || null,
    forecasts
  };
}

function buildGoogleDisplayDateIso(displayDate, fallbackDateTime) {
  const year = Number(displayDate?.year);
  const month = Number(displayDate?.month);
  const day = Number(displayDate?.day);

  if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
    return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  }

  const fallbackDate = new Date(fallbackDateTime);

  if (!Number.isFinite(fallbackDate.getTime())) {
    return null;
  }

  return fallbackDate.toISOString().slice(0, 10);
}

function buildGoogleMetricSummary({ label, unit, values, decimalPlaces, updatedAt, nearestValue }) {
  const validValues = values.filter((value) => Number.isFinite(value));

  if (!validValues.length) {
    return {
      label,
      unit,
      average: null,
      nearest: null,
      min: null,
      max: null,
      stationCount: 0,
      updatedAt
    };
  }

  const averageValue = validValues.reduce((total, value) => total + value, 0) / validValues.length;

  return {
    label,
    unit,
    average: roundNumber(averageValue, decimalPlaces),
    nearest: Number.isFinite(nearestValue)
      ? {
          value: roundNumber(nearestValue, decimalPlaces),
          stationId: "google-weather",
          stationName: "Google Weather",
          distanceMeters: 0
        }
      : null,
    min: roundNumber(Math.min(...validValues), decimalPlaces),
    max: roundNumber(Math.max(...validValues), decimalPlaces),
    stationCount: validValues.length,
    updatedAt
  };
}

function normalizeGoogleConditionText(conditionPayload) {
  const descriptionText = String(conditionPayload?.description?.text || "").trim();

  if (descriptionText) {
    return descriptionText;
  }

  const typeValue = String(conditionPayload?.type || "").trim();

  if (!typeValue) {
    return "Unavailable";
  }

  return normalizeGoogleWeatherType(typeValue);
}

function normalizeGoogleWeatherType(typeValue) {
  const normalizedType = String(typeValue || "").trim().toLowerCase();

  if (!normalizedType) {
    return "Unavailable";
  }

  return normalizedType
    .split(/[_\s]+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function getDominantLabel(values, fallbackValue = "Unavailable") {
  const countByLabel = new Map();

  for (const value of values) {
    const label = String(value || "").trim();

    if (!label || label === "Unavailable") {
      continue;
    }

    countByLabel.set(label, (countByLabel.get(label) || 0) + 1);
  }

  if (!countByLabel.size) {
    return fallbackValue;
  }

  return Array.from(countByLabel.entries())
    .sort((left, right) => {
      if (left[1] === right[1]) {
        return left[0].localeCompare(right[0]);
      }

      return right[1] - left[1];
    })[0][0];
}

function convertSpeedToKph(value, unitValue) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalizedUnit = String(unitValue || "").trim().toUpperCase();

  if (normalizedUnit === "MILES_PER_HOUR") {
    return value * 1.60934;
  }

  if (normalizedUnit === "METERS_PER_SECOND") {
    return value * 3.6;
  }

  if (normalizedUnit === "KNOTS") {
    return value * 1.852;
  }

  return value;
}

function convertPrecipitationToMillimeters(value, unitValue) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalizedUnit = String(unitValue || "").trim().toUpperCase();

  if (normalizedUnit === "INCHES") {
    return value * 25.4;
  }

  if (normalizedUnit === "CENTIMETERS") {
    return value * 10;
  }

  if (normalizedUnit === "METERS") {
    return value * 1000;
  }

  return value;
}

function getUvFallbackCacheKey(requestedCenter) {
  const latitude = parseFiniteNumber(requestedCenter?.lat);
  const longitude = parseFiniteNumber(requestedCenter?.lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return `${SG_DEFAULT_CENTER.lat.toFixed(2)},${SG_DEFAULT_CENTER.lng.toFixed(2)}`;
  }

  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

async function getCachedBackupUvIndexSummary(requestedCenter) {
  const cacheKey = getUvFallbackCacheKey(requestedCenter);
  let cacheEntry = weatherUvFallbackCache.get(cacheKey);

  if (!cacheEntry) {
    cacheEntry = createCacheEntry();
    weatherUvFallbackCache.set(cacheKey, cacheEntry);
  }

  const cacheAge = Date.now() - cacheEntry.fetchedAt;

  if (cacheEntry.value && cacheAge < WEATHER_UV_FALLBACK_CACHE_TTL_MS) {
    return cacheEntry.value;
  }

  if (cacheEntry.pending) {
    return cacheEntry.pending;
  }

  const latitude = parseFiniteNumber(requestedCenter?.lat) ?? SG_DEFAULT_CENTER.lat;
  const longitude = parseFiniteNumber(requestedCenter?.lng) ?? SG_DEFAULT_CENTER.lng;
  const searchParams = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    current: "uv_index",
    hourly: "uv_index",
    forecast_days: "1",
    timezone: "Asia/Singapore"
  });
  const endpointUrl = `${OPEN_METEO_FORECAST_BASE_URL}?${searchParams.toString()}`;

  cacheEntry.pending = fetchJsonWithTimeout(endpointUrl)
    .then((payload) => {
      const summary = buildOpenMeteoUvSummary(payload);

      if (!summary) {
        throw new WeatherApiError(502, "Backup UV source returned incomplete data.");
      }

      cacheEntry.value = summary;
      cacheEntry.fetchedAt = Date.now();
      return summary;
    })
    .catch((error) => {
      if (cacheEntry.value) {
        console.warn("Backup UV source refresh failed; serving stale UV cache.", error);
        return cacheEntry.value;
      }

      throw error;
    })
    .finally(() => {
      cacheEntry.pending = null;
    });

  return cacheEntry.pending;
}

async function getCachedPayload(cacheKey, url) {
  const cacheEntry = weatherPayloadCache[cacheKey];

  if (!cacheEntry) {
    return fetchJsonWithTimeout(url);
  }

  const cacheAge = Date.now() - cacheEntry.fetchedAt;

  if (cacheEntry.value && cacheAge < WEATHER_CACHE_TTL_MS) {
    return cacheEntry.value;
  }

  if (cacheEntry.pending) {
    return cacheEntry.pending;
  }

  cacheEntry.pending = fetchJsonWithTimeout(url)
    .then((payload) => {
      cacheEntry.value = payload;
      cacheEntry.fetchedAt = Date.now();
      return payload;
    })
    .catch((error) => {
      if (cacheEntry.value) {
        console.warn("Weather upstream refresh failed; serving stale cache.", error);
        return cacheEntry.value;
      }

      throw error;
    })
    .finally(() => {
      cacheEntry.pending = null;
    });

  return cacheEntry.pending;
}

function buildForecastSummary(payload, requestedCenter) {
  const areaMetadata = Array.isArray(payload?.area_metadata) ? payload.area_metadata : [];
  const metadataByAreaName = new Map(
    areaMetadata.map((entry) => [
      String(entry?.name || "").trim(),
      {
        lat: Number(entry?.label_location?.latitude),
        lng: Number(entry?.label_location?.longitude)
      }
    ])
  );

  const snapshot = Array.isArray(payload?.items) ? payload.items[0] : null;
  const forecasts = Array.isArray(snapshot?.forecasts) ? snapshot.forecasts : [];
  const conditions = forecasts
    .map((entry) => {
      const areaName = String(entry?.area || "").trim();
      const forecastText = String(entry?.forecast || "").trim();
      const metadata = metadataByAreaName.get(areaName) || {};
      const lat = Number(metadata?.lat);
      const lng = Number(metadata?.lng);
      const hasValidCoordinates = Number.isFinite(lat) && Number.isFinite(lng);

      return {
        area: areaName || "Unknown area",
        forecast: forecastText || "Unavailable",
        lat: hasValidCoordinates ? lat : null,
        lng: hasValidCoordinates ? lng : null,
        distanceMeters: hasValidCoordinates
          ? getDistanceMeters(requestedCenter.lat, requestedCenter.lng, lat, lng)
          : null
      };
    })
    .sort((left, right) => {
      const leftDistance = Number.isFinite(left.distanceMeters)
        ? left.distanceMeters
        : Number.POSITIVE_INFINITY;
      const rightDistance = Number.isFinite(right.distanceMeters)
        ? right.distanceMeters
        : Number.POSITIVE_INFINITY;

      if (leftDistance === rightDistance) {
        return left.area.localeCompare(right.area);
      }

      return leftDistance - rightDistance;
    });

  const conditionCountMap = new Map();

  for (const condition of conditions) {
    const key = condition.forecast;
    conditionCountMap.set(key, (conditionCountMap.get(key) || 0) + 1);
  }

  const conditionBreakdown = Array.from(conditionCountMap.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([forecast, areaCount]) => ({
      forecast,
      areaCount
    }));

  const dominantCondition = conditionBreakdown[0]?.forecast || "Unavailable";
  const rainingAreas = conditions.filter((condition) => isRainForecast(condition.forecast)).length;
  const thunderAreas = conditions.filter((condition) => /thunder/i.test(condition.forecast)).length;

  return {
    updatedAt: String(snapshot?.update_timestamp || snapshot?.timestamp || "").trim() || null,
    validPeriod: snapshot?.valid_period || null,
    conditions,
    conditionBreakdown,
    overview: {
      totalAreas: conditions.length,
      dominantCondition,
      rainingAreas,
      thunderAreas
    }
  };
}

function buildTwentyFourHourForecastSummary(payload) {
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  const general = item?.general || {};
  const periods = Array.isArray(item?.periods)
    ? item.periods.slice(0, 3).map((period) => {
        const regions = period?.regions || {};
        const regionForecasts = Object.values(regions)
          .map((value) => String(value || "").trim())
          .filter(Boolean);

        const dominantForecast =
          String(regions?.central || "").trim() || regionForecasts[0] || "Unavailable";

        return {
          start: String(period?.time?.start || "").trim() || null,
          end: String(period?.time?.end || "").trim() || null,
          forecast: dominantForecast,
          regions: {
            west: String(regions?.west || "").trim() || "Unavailable",
            east: String(regions?.east || "").trim() || "Unavailable",
            central: String(regions?.central || "").trim() || "Unavailable",
            south: String(regions?.south || "").trim() || "Unavailable",
            north: String(regions?.north || "").trim() || "Unavailable"
          }
        };
      })
    : [];

  return {
    updatedAt: String(item?.update_timestamp || item?.timestamp || "").trim() || null,
    validPeriod: item?.valid_period || null,
    generalForecast: String(general?.forecast || "").trim() || "Unavailable",
    temperature: {
      low: parseFiniteNumber(general?.temperature?.low),
      high: parseFiniteNumber(general?.temperature?.high)
    },
    humidity: {
      low: parseFiniteNumber(general?.relative_humidity?.low),
      high: parseFiniteNumber(general?.relative_humidity?.high)
    },
    wind: {
      direction: String(general?.wind?.direction || "").trim() || "Unavailable",
      speedLow: parseFiniteNumber(general?.wind?.speed?.low),
      speedHigh: parseFiniteNumber(general?.wind?.speed?.high)
    },
    periods
  };
}

function buildFourDayForecastSummary(payload) {
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  const forecasts = Array.isArray(item?.forecasts)
    ? item.forecasts.slice(0, 4).map((entry) => {
        const dateValue = String(entry?.date || entry?.timestamp || "").trim();
        const dateObject = new Date(dateValue);
        const hasValidDate = Number.isFinite(dateObject.getTime());

        return {
          date: hasValidDate ? dateObject.toISOString().slice(0, 10) : null,
          day: hasValidDate
            ? dateObject.toLocaleDateString("en-SG", {
                weekday: "long"
              })
            : "Unknown",
          forecast: String(entry?.forecast || "").trim() || "Unavailable",
          temperatureLow: parseFiniteNumber(entry?.temperature?.low),
          temperatureHigh: parseFiniteNumber(entry?.temperature?.high)
        };
      })
    : [];

  return {
    updatedAt: String(item?.update_timestamp || item?.timestamp || "").trim() || null,
    forecasts
  };
}

function buildStationMetricSummary(payload, requestedCenter, label, unitFallback, decimalPlaces) {
  const metadataStations = Array.isArray(payload?.metadata?.stations)
    ? payload.metadata.stations
    : [];
  const stationMetadataById = new Map(
    metadataStations.map((station) => [
      String(station?.id || "").trim(),
      {
        name: String(station?.name || station?.id || "").trim() || "Unknown station",
        lat: Number(station?.location?.latitude),
        lng: Number(station?.location?.longitude)
      }
    ])
  );

  const latestItem = Array.isArray(payload?.items) ? payload.items[0] : null;
  const readings = Array.isArray(latestItem?.readings) ? latestItem.readings : [];
  const validReadings = readings
    .map((reading) => ({
      stationId: String(reading?.station_id || "").trim(),
      value: Number(reading?.value)
    }))
    .filter((reading) => reading.stationId && Number.isFinite(reading.value));

  if (!validReadings.length) {
    return {
      label,
      unit: normalizeReadingUnit(payload?.metadata?.reading_unit, unitFallback),
      average: null,
      nearest: null,
      min: null,
      max: null,
      stationCount: 0,
      updatedAt: String(latestItem?.update_timestamp || latestItem?.timestamp || "").trim() || null
    };
  }

  const averageValue =
    validReadings.reduce((sum, reading) => sum + reading.value, 0) / validReadings.length;

  const nearestReading = findNearestStationReading(
    validReadings,
    stationMetadataById,
    requestedCenter
  );

  const readingValues = validReadings.map((reading) => reading.value);

  return {
    label,
    unit: normalizeReadingUnit(payload?.metadata?.reading_unit, unitFallback),
    average: roundNumber(averageValue, decimalPlaces),
    nearest: nearestReading
      ? {
          value: roundNumber(nearestReading.value, decimalPlaces),
          stationId: nearestReading.stationId,
          stationName: nearestReading.stationName,
          distanceMeters: nearestReading.distanceMeters
        }
      : null,
    min: roundNumber(Math.min(...readingValues), decimalPlaces),
    max: roundNumber(Math.max(...readingValues), decimalPlaces),
    stationCount: validReadings.length,
    updatedAt: String(latestItem?.update_timestamp || latestItem?.timestamp || "").trim() || null
  };
}

function normalizeReadingUnit(rawUnit, fallbackUnit) {
  const normalizedUnit = String(rawUnit || fallbackUnit || "").trim().toLowerCase();

  if (!normalizedUnit) {
    return String(fallbackUnit || "").trim() || "unit";
  }

  if (normalizedUnit === "%" || normalizedUnit.includes("percent")) {
    return "%";
  }

  return String(rawUnit || fallbackUnit).trim();
}

function buildOpenMeteoUvSummary(payload) {
  const currentValue = parseFiniteNumber(payload?.current?.uv_index);
  const hourlyValues = Array.isArray(payload?.hourly?.uv_index)
    ? payload.hourly.uv_index.map(parseFiniteNumber).filter((value) => Number.isFinite(value))
    : [];
  const uvValues = hourlyValues.length
    ? hourlyValues
    : Number.isFinite(currentValue)
      ? [currentValue]
      : [];

  if (!uvValues.length) {
    return null;
  }

  const currentUvValue = Number.isFinite(currentValue) ? currentValue : uvValues[0];

  return {
    label: "UV index",
    unit: "index",
    current: roundNumber(currentUvValue, 1),
    min: roundNumber(Math.min(...uvValues), 1),
    max: roundNumber(Math.max(...uvValues), 1),
    category: resolveUvCategory(currentUvValue),
    updatedAt: parseOpenMeteoTimeToIso(payload?.current?.time, new Date().toISOString()),
    source: "open-meteo"
  };
}

function parseOpenMeteoTimeToIso(rawTimeValue, fallbackValue) {
  const rawTime = String(rawTimeValue || "").trim();

  if (!rawTime) {
    return fallbackValue;
  }

  const hasOffset = /([zZ]|[+-]\d{2}:\d{2})$/.test(rawTime);
  const isoCandidate = hasOffset ? rawTime : `${rawTime}+08:00`;
  const parsedDate = new Date(isoCandidate);

  if (!Number.isFinite(parsedDate.getTime())) {
    return fallbackValue;
  }

  return parsedDate.toISOString();
}

function buildEstimatedUvModelSummary(referenceDate = new Date()) {
  const singaporeHour = getSingaporeHourDecimal(referenceDate);
  const hourValue = Number.isFinite(singaporeHour) ? singaporeHour : 12;
  const daylightProgress = clampUnitRange((hourValue - 6) / 12);
  const isDaylight = hourValue >= 6 && hourValue <= 18.5;
  const modeledCurrent = isDaylight ? 9.4 * Math.sin(daylightProgress * Math.PI) ** 1.45 : 0;

  return {
    label: "UV index",
    unit: "index",
    current: roundNumber(modeledCurrent, 1),
    min: 0,
    max: 9.4,
    category: resolveUvCategory(modeledCurrent),
    updatedAt: referenceDate.toISOString(),
    source: "estimated-model"
  };
}

function getSingaporeHourDecimal(referenceDate = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = formatter.formatToParts(referenceDate);
  const hourPart = Number(parts.find((part) => part.type === "hour")?.value);
  const minutePart = Number(parts.find((part) => part.type === "minute")?.value);

  if (!Number.isFinite(hourPart) || !Number.isFinite(minutePart)) {
    return null;
  }

  return hourPart + minutePart / 60;
}

function clampUnitRange(value) {
  return Math.min(Math.max(value, 0), 1);
}

function buildUvIndexMetricSummary(payload, fallbackSummary = null) {
  const latestItem = Array.isArray(payload?.items) ? payload.items[0] : null;
  const indexReadings = Array.isArray(latestItem?.index) ? latestItem.index : [];
  const validValues = indexReadings
    .map((entry) => Number(entry?.value))
    .filter((value) => Number.isFinite(value));

  if (!validValues.length) {
    if (fallbackSummary) {
      return {
        label: fallbackSummary.label || "UV index",
        unit: fallbackSummary.unit || "index",
        current: parseFiniteNumber(fallbackSummary.current),
        min: parseFiniteNumber(fallbackSummary.min),
        max: parseFiniteNumber(fallbackSummary.max),
        category:
          String(fallbackSummary.category || "").trim() ||
          resolveUvCategory(parseFiniteNumber(fallbackSummary.current)),
        updatedAt: String(fallbackSummary.updatedAt || "").trim() || null,
        source: String(fallbackSummary.source || "open-meteo")
      };
    }

    return buildEstimatedUvModelSummary();
  }

  const currentValue = validValues[0];

  return {
    label: "UV index",
    unit: "index",
    current: roundNumber(currentValue, 1),
    min: roundNumber(Math.min(...validValues), 1),
    max: roundNumber(Math.max(...validValues), 1),
    category: resolveUvCategory(currentValue),
    updatedAt: String(latestItem?.update_timestamp || latestItem?.timestamp || "").trim() || null,
    source: "data.gov.sg"
  };
}

function resolveUvCategory(value) {
  if (!Number.isFinite(value)) {
    return "Unavailable";
  }

  if (value < 3) {
    return "Low";
  }

  if (value < 6) {
    return "Moderate";
  }

  if (value < 8) {
    return "High";
  }

  if (value < 11) {
    return "Very High";
  }

  return "Extreme";
}

function findNearestStationReading(readings, stationMetadataById, requestedCenter) {
  let bestCandidate = null;

  for (const reading of readings) {
    const stationMetadata = stationMetadataById.get(reading.stationId) || null;

    if (!stationMetadata) {
      continue;
    }

    const hasCoordinates = Number.isFinite(stationMetadata.lat) && Number.isFinite(stationMetadata.lng);
    const distanceMeters = hasCoordinates
      ? getDistanceMeters(
          requestedCenter.lat,
          requestedCenter.lng,
          stationMetadata.lat,
          stationMetadata.lng
        )
      : Number.POSITIVE_INFINITY;

    if (distanceMeters > WEATHER_MAX_RADIUS_METERS) {
      continue;
    }

    if (!bestCandidate || distanceMeters < bestCandidate.distanceMeters) {
      bestCandidate = {
        stationId: reading.stationId,
        stationName: stationMetadata.name,
        value: reading.value,
        distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null
      };
    }
  }

  if (bestCandidate) {
    return bestCandidate;
  }

  const fallback = readings[0];
  const fallbackMetadata = stationMetadataById.get(fallback.stationId) || null;

  return {
    stationId: fallback.stationId,
    stationName: fallbackMetadata?.name || "Unknown station",
    value: fallback.value,
    distanceMeters: null
  };
}

function parseQueryFloat(value, fallbackValue) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
}

function parseFiniteNumber(value) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function roundNumber(value, decimalPlaces) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

function isRainForecast(forecastText) {
  return /(rain|shower|thunder|drizzle|storm)/i.test(String(forecastText || ""));
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
      throw new WeatherApiError(504, "Weather data source took too long to respond.");
    }

    throw new WeatherApiError(502, "Weather data source could not be reached.", String(error));
  }

  if (!response.ok) {
    const detail = await response.text();

    throw new WeatherApiError(
      502,
      "Weather data source returned an unsuccessful response.",
      detail.slice(0, 300)
    );
  }

  return response.json();
}

function handleWeatherApiError(response, error) {
  const status = error instanceof WeatherApiError ? error.status : 500;
  const message =
    error instanceof WeatherApiError
      ? error.message
      : "Weather dashboard data could not be loaded right now.";

  response.status(status).json({
    error: message,
    detail: error instanceof WeatherApiError ? error.detail : String(error)
  });
}

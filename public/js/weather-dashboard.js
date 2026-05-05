const WEATHER_SECTION_ID = "workspace-weather";
const WEATHER_FORECAST_CARDS_ID = "workspace-weather-forecast-cards";
const WEATHER_METRICS_ID = "workspace-weather-metrics";
const WEATHER_TREND_CHART_ID = "workspace-weather-trend-chart";
const WEATHER_TREND_SUB_ID = "workspace-weather-trend-sub";
const WEATHER_UPDATED_ID = "workspace-weather-updated";
const WEATHER_META_ID = "workspace-weather-meta";
const WEATHER_REFERENCE_ID = "workspace-weather-eyebrow";
const WEATHER_NOTICE_ID = "workspace-weather-notice";
const WEATHER_NOW_TEMP_ID = "workspace-weather-now-temp";
const WEATHER_NOW_CONDITION_ID = "workspace-weather-now-condition";
const WEATHER_NOW_LOCATION_ID = "workspace-weather-now-location";

const WEATHER_REFRESH_INTERVAL_MS = 120_000;
const WEATHER_DEFAULT_CENTER = {
  lat: 1.3483,
  lng: 103.6831
};
const USER_LOCATION_MAX_AGE_MS = 60_000;
const USER_LOCATION_TIMEOUT_MS = 9_000;
const WEATHER_TREND_POINT_INTERVAL_MINUTES = 30;
const WEATHER_TREND_LOOKAHEAD_HOURS = 24;
const WEATHER_TREND_POINT_COUNT =
  (WEATHER_TREND_LOOKAHEAD_HOURS * 60) / WEATHER_TREND_POINT_INTERVAL_MINUTES + 1;
const WEATHER_TREND_LABEL_EVERY_POINTS = 2;
const WEATHER_TREND_ICON_EVERY_POINTS = 4;

const weatherSectionElement = document.querySelector(`#${WEATHER_SECTION_ID}`);
const weatherForecastCardsElement = document.querySelector(`#${WEATHER_FORECAST_CARDS_ID}`);
const weatherMetricsElement = document.querySelector(`#${WEATHER_METRICS_ID}`);
const weatherTrendChartElement = document.querySelector(`#${WEATHER_TREND_CHART_ID}`);
const weatherTrendSubElement = document.querySelector(`#${WEATHER_TREND_SUB_ID}`);
const weatherUpdatedElement = document.querySelector(`#${WEATHER_UPDATED_ID}`);
const weatherMetaElement = document.querySelector(`#${WEATHER_META_ID}`);
const weatherReferenceElement = document.querySelector(`#${WEATHER_REFERENCE_ID}`);
const weatherNoticeElement = document.querySelector(`#${WEATHER_NOTICE_ID}`);
const weatherNowTempElement = document.querySelector(`#${WEATHER_NOW_TEMP_ID}`);
const weatherNowConditionElement = document.querySelector(`#${WEATHER_NOW_CONDITION_ID}`);
const weatherNowLocationElement = document.querySelector(`#${WEATHER_NOW_LOCATION_ID}`);

let weatherRefreshTimerId = 0;
let weatherRenderSequence = 0;
let weatherDashboardInitialized = false;
let weatherUserLocation = null;
let weatherLastSuccessfulState = null;

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

const formatUpdatedLabel = (isoDateTime) => {
  if (!isoDateTime) {
    return "Weather updates unavailable right now.";
  }

  const timestampMs = new Date(isoDateTime).getTime();

  if (!Number.isFinite(timestampMs)) {
    return "Weather updates unavailable right now.";
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

const formatDateLabel = (isoDate) => {
  const value = new Date(isoDate);

  if (!Number.isFinite(value.getTime())) {
    return "Date unavailable";
  }

  return value.toLocaleDateString("en-SG", {
    month: "short",
    day: "2-digit"
  });
};

const formatTimeLabel = (dateValue) => {
  const value = new Date(dateValue);

  if (!Number.isFinite(value.getTime())) {
    return "--:--";
  }

  return value.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
};

const roundDownToNearestHalfHour = (dateValue) => {
  const roundedDate = new Date(dateValue);

  if (!Number.isFinite(roundedDate.getTime())) {
    return Date.now();
  }

  roundedDate.setSeconds(0, 0);
  const minutes = roundedDate.getMinutes();
  roundedDate.setMinutes(minutes < 30 ? 0 : 30);

  return roundedDate.getTime();
};

const formatNumber = (value, maximumFractionDigits = 1) => {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits
  });
};

const normalizeDisplayUnit = (unit) => {
  const normalized = String(unit || "").trim().toLowerCase();

  if (normalized === "%" || normalized.includes("percent")) {
    return "%";
  }

  return String(unit || "").trim();
};

const formatRangeValue = (min, max, unit, maximumFractionDigits = 1) => {
  const minText = formatNumber(min, maximumFractionDigits);
  const maxText = formatNumber(max, maximumFractionDigits);
  const displayUnit = normalizeDisplayUnit(unit);

  if (!minText || !maxText) {
    return "Unavailable";
  }

  return `${minText} - ${maxText} ${displayUnit}`;
};

const formatSingleValue = (value, unit, maximumFractionDigits = 1) => {
  const numberText = formatNumber(value, maximumFractionDigits);
  const displayUnit = normalizeDisplayUnit(unit);
  return numberText ? `${numberText} ${displayUnit}` : "Unavailable";
};

const formatCoordinates = (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "Coordinates unavailable";
  }

  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
};

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const resolveUvCategoryLabel = (value) => {
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
};

const resolveTrendWeatherSymbol = (timestampMs, conditionText) => {
  const normalizedCondition = String(conditionText || "").toLowerCase();

  if (/thunder|storm|rain|shower|drizzle/.test(normalizedCondition)) {
    return "🌧";
  }

  if (/cloud|haze|mist|fog|smoke/.test(normalizedCondition)) {
    return "☁";
  }

  const timestamp = new Date(timestampMs);
  const hourDecimal = timestamp.getHours() + timestamp.getMinutes() / 60;
  return hourDecimal >= 7 && hourDecimal < 18.75 ? "☀" : "☁";
};

const getReferenceCenter = () => {
  if (Number.isFinite(weatherUserLocation?.lat) && Number.isFinite(weatherUserLocation?.lng)) {
    return {
      lat: weatherUserLocation.lat,
      lng: weatherUserLocation.lng,
      source: "user-location"
    };
  }

  return {
    ...WEATHER_DEFAULT_CENTER,
    source: "default"
  };
};

const setWeatherReferenceLabel = (source) => {
  if (!weatherReferenceElement) {
    return;
  }

  weatherReferenceElement.textContent =
    source === "user-location" ? "Location detected" : "Using Singapore default";
};

const setWeatherNotice = (message = "") => {
  if (!weatherNoticeElement) {
    return;
  }

  if (!message) {
    weatherNoticeElement.hidden = true;
    weatherNoticeElement.textContent = "";
    return;
  }

  weatherNoticeElement.hidden = false;
  weatherNoticeElement.textContent = message;
};

const getForecastToneClass = (forecast) => {
  const normalized = String(forecast || "").toLowerCase();

  if (/thunder|storm/.test(normalized)) {
    return "tone-thunder";
  }

  if (/rain|shower|drizzle/.test(normalized)) {
    return "tone-rain";
  }

  if (/haze|mist|fog|smoke/.test(normalized)) {
    return "tone-haze";
  }

  if (/fair|sunny|clear/.test(normalized)) {
    return "tone-clear";
  }

  return "tone-cloudy";
};

const getForecastIconMarkup = (forecast) => {
  const toneClass = getForecastToneClass(forecast);

  if (toneClass === "tone-thunder") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6.8 14.4h8.5a3 3 0 0 0 .2-5.9 4.2 4.2 0 0 0-8.3.7 2.7 2.7 0 0 0-.4 5.2Z" />
        <path d="m11.5 14.2-1 3h2.1l-1 3.1" />
      </svg>
    `;
  }

  if (toneClass === "tone-rain") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6.8 14.4h8.6a3 3 0 0 0 .2-5.9 4.2 4.2 0 0 0-8.3.7 2.7 2.7 0 0 0-.5 5.2Z" />
        <path d="M9.2 16.5v1.8M12.2 16.5v1.8M15.2 16.5v1.8" />
      </svg>
    `;
  }

  if (toneClass === "tone-clear") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="13.2" cy="9" r="3.2" />
        <path d="M13.2 3.5v1.7M13.2 12.8v1.7M8.1 9h1.7M16.6 9h1.7" />
        <path d="M5.8 17.1h9.4a2.6 2.6 0 1 0-.2-5.2 3.9 3.9 0 0 0-7.6.6 2.4 2.4 0 0 0-1.6 4.6Z" />
      </svg>
    `;
  }

  if (toneClass === "tone-haze") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5.6 10.8h12.8M4.8 13.6h14.4M6.2 16.4h11.6" />
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.8 14.4h8.6a3 3 0 0 0 .2-5.9 4.2 4.2 0 0 0-8.3.7 2.7 2.7 0 0 0-.5 5.2Z" />
      <path d="M15.8 5.1a2.6 2.6 0 0 1 2.6 2.6" />
    </svg>
  `;
};

const getHighlightIconMarkup = (iconName) => {
  if (iconName === "temperature") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M10.1 5.5a1.9 1.9 0 0 1 3.8 0v7.1a3.8 3.8 0 1 1-3.8 0V5.5Z" />
        <path d="M12 9.6v5.1" />
      </svg>
    `;
  }

  if (iconName === "wind") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4.5 9.2h9.9a2.4 2.4 0 1 0-2.4-2.4" />
        <path d="M4.5 13.2h13.2a2.4 2.4 0 1 1-2.4 2.4" />
        <path d="M4.5 17.2h7.2" />
      </svg>
    `;
  }

  if (iconName === "rain") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6.8 14.3h8.6a3 3 0 0 0 .2-5.9 4.2 4.2 0 0 0-8.3.8 2.7 2.7 0 0 0-.5 5.1Z" />
        <path d="M9.3 16.5v2M12.3 16.5v2M15.3 16.5v2" />
      </svg>
    `;
  }

  if (iconName === "humidity") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4s4.8 4.8 4.8 8.1a4.8 4.8 0 1 1-9.6 0C7.2 8.8 12 4 12 4Z" />
      </svg>
    `;
  }

  if (iconName === "uv") {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="3.9" />
        <path d="M12 3.1v2.1M12 18.8v2.1M3.1 12h2.1M18.8 12h2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M18.2 5.8l-1.5 1.5M7.3 16.7l-1.5 1.5" />
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 21s6-5.1 6-10a6 6 0 1 0-12 0c0 4.9 6 10 6 10Z" />
      <circle cx="12" cy="11" r="2.2" />
    </svg>
  `;
};

const renderForecastCards = (payload) => {
  if (!weatherForecastCardsElement) {
    return;
  }

  const dailyForecasts = Array.isArray(payload?.forecast4d?.forecasts)
    ? payload.forecast4d.forecasts.slice(0, 3)
    : [];

  if (!dailyForecasts.length) {
    const fallbackCondition =
      payload?.forecast24h?.generalForecast || payload?.overview?.dominantCondition || "Unavailable";

    weatherForecastCardsElement.innerHTML = `
      <article class="workspace-weather-forecast-card ${getForecastToneClass(fallbackCondition)}" role="listitem">
        <div class="workspace-weather-forecast-card__icon">${getForecastIconMarkup(fallbackCondition)}</div>
        <p class="workspace-weather-forecast-card__temp">--</p>
        <p class="workspace-weather-forecast-card__day">Forecast pending</p>
        <p class="workspace-weather-forecast-card__date">Data refresh in progress</p>
      </article>
    `;
    return;
  }

  weatherForecastCardsElement.innerHTML = dailyForecasts
    .map((entry) => {
      const forecastText = entry?.forecast || "Unavailable";
      const low = formatNumber(entry?.temperatureLow, 0);
      const high = formatNumber(entry?.temperatureHigh, 0);
      const temperatureLabel = low && high ? `${low}°/${high}°` : "--";

      return `
        <article class="workspace-weather-forecast-card ${getForecastToneClass(forecastText)}" role="listitem">
          <div class="workspace-weather-forecast-card__icon">${getForecastIconMarkup(forecastText)}</div>
          <p class="workspace-weather-forecast-card__temp">${escapeHtml(temperatureLabel)}</p>
          <p class="workspace-weather-forecast-card__day">${escapeHtml(entry?.day || "Unknown")}</p>
          <p class="workspace-weather-forecast-card__date">${escapeHtml(formatDateLabel(entry?.date))}</p>
        </article>
      `;
    })
    .join("");
};

const renderShowcase = (payload, referenceSource) => {
  setWeatherReferenceLabel(referenceSource);

  const temperatureMetric = payload?.metrics?.temperatureC || {};
  const averageTemperature = Number(temperatureMetric?.average);
  const fallbackLow = Number(payload?.forecast24h?.temperature?.low);
  const fallbackHigh = Number(payload?.forecast24h?.temperature?.high);
  const midpointTemperature =
    Number.isFinite(fallbackLow) && Number.isFinite(fallbackHigh)
      ? (fallbackLow + fallbackHigh) / 2
      : null;
  const currentTempValue = Number.isFinite(averageTemperature)
    ? averageTemperature
    : Number.isFinite(midpointTemperature)
      ? midpointTemperature
      : null;

  if (weatherNowTempElement) {
    weatherNowTempElement.innerHTML = Number.isFinite(currentTempValue)
      ? `${escapeHtml(formatNumber(currentTempValue, 0))}<span>°C</span>`
      : `--<span>°C</span>`;
  }

  const primaryCondition =
    payload?.forecast24h?.generalForecast ||
    payload?.conditions?.[0]?.forecast ||
    payload?.overview?.dominantCondition ||
    "Unavailable";

  if (weatherNowConditionElement) {
    weatherNowConditionElement.textContent = primaryCondition;
  }

  if (weatherNowLocationElement) {
    const nearestArea = payload?.conditions?.[0]?.area;
    const locationLabel = nearestArea ? `Near ${nearestArea}` : "Singapore";
    const coordinateLabel = formatCoordinates(payload?.center?.lat, payload?.center?.lng);
    weatherNowLocationElement.textContent = `${locationLabel} · ${coordinateLabel}`;
  }

  if (weatherMetaElement) {
    const windowStart = payload?.forecast24h?.validPeriod?.start;
    const windowEnd = payload?.forecast24h?.validPeriod?.end;
    if (windowStart && windowEnd) {
      weatherMetaElement.textContent = `${formatTimeLabel(windowStart)} to ${formatTimeLabel(windowEnd)}`;
    } else {
      weatherMetaElement.textContent = "Forecast window unavailable";
    }
  }

  if (weatherUpdatedElement) {
    weatherUpdatedElement.textContent = formatUpdatedLabel(payload?.updatedAt);
  }

  renderForecastCards(payload);
};

const renderHighlightCard = ({ icon, title, value, meta, toneClass = "" }) => `
  <article class="workspace-weather-highlight-card ${toneClass}" role="listitem">
    <div class="workspace-weather-highlight-card__head">
      <span class="workspace-weather-highlight-card__icon">${getHighlightIconMarkup(icon)}</span>
      <div>
        <p class="workspace-weather-highlight-card__title">${escapeHtml(title)}</p>
        <p class="workspace-weather-highlight-card__meta">${escapeHtml(meta)}</p>
      </div>
    </div>
    <p class="workspace-weather-highlight-card__value">${escapeHtml(value)}</p>
  </article>
`;

const renderHighlights = (payload) => {
  if (!weatherMetricsElement) {
    return;
  }

  const metrics = payload?.metrics || {};
  const temperature = metrics?.temperatureC || null;
  const humidity = metrics?.humidityPct || null;
  const uvIndex = metrics?.uvIndex || null;
  const wind = payload?.forecast24h?.wind || null;
  const uvSourceLabel =
    uvIndex?.source === "google-weather"
      ? "Google source"
      : uvIndex?.source === "open-meteo"
      ? "Backup source"
      : uvIndex?.source === "estimated-model"
        ? "Estimated source"
      : uvIndex?.source === "data.gov.sg"
        ? "Primary source"
        : "Source unavailable";

  const uvCurrentValue = Number(uvIndex?.current);
  const uvPeakValue = Number(uvIndex?.max);
  const uvVisibleValue = Number.isFinite(uvCurrentValue)
    ? uvCurrentValue
    : Number.isFinite(uvPeakValue)
      ? uvPeakValue
      : null;
  const uvCategoryLabel =
    String(uvIndex?.category || "").trim() || resolveUvCategoryLabel(uvVisibleValue);
  const uvValueText = Number.isFinite(uvVisibleValue)
    ? `${formatNumber(uvVisibleValue, 1)} (${uvCategoryLabel})`
    : "Unavailable";

  const feelsLikeValue = Number(temperature?.average);
  const humidityValue = Number(humidity?.average);
  const feelsLikeAdjusted =
    Number.isFinite(feelsLikeValue) && Number.isFinite(humidityValue)
      ? feelsLikeValue + clampNumber((humidityValue - 60) * 0.03, -1.2, 2.4)
      : null;

  const windLow = Number(wind?.speedLow);
  const windHigh = Number(wind?.speedHigh);
  const windRangeLabel =
    Number.isFinite(windLow) && Number.isFinite(windHigh)
      ? `${formatNumber(windLow, 0)} - ${formatNumber(windHigh, 0)} km/h`
      : formatSingleValue(metrics?.windSpeedMs?.average, metrics?.windSpeedMs?.unit || "m/s");

  const rainForecastText =
    payload?.forecast24h?.generalForecast ||
    payload?.conditions?.[0]?.forecast ||
    payload?.overview?.dominantCondition ||
    "Unavailable";

  const cards = [
    renderHighlightCard({
      icon: "temperature",
      title: "Feels Like",
      value: formatSingleValue(feelsLikeAdjusted, "°C", 1),
      meta: "Adjusted from humidity",
      toneClass: "tone-temperature"
    }),
    renderHighlightCard({
      icon: "wind",
      title: "Wind",
      value: windRangeLabel,
      meta: wind?.direction ? `Direction ${wind.direction}` : "Direction unavailable",
      toneClass: "tone-wind"
    }),
    renderHighlightCard({
      icon: "rain",
      title: "Rain Forecast",
      value: rainForecastText,
      meta: `${Number(payload?.overview?.rainingAreas) || 0} areas expecting rain`,
      toneClass: getForecastToneClass(rainForecastText)
    }),
    renderHighlightCard({
      icon: "humidity",
      title: "Humidity",
      value: formatSingleValue(humidity?.average, humidity?.unit || "%", 0),
      meta: `Range ${formatRangeValue(humidity?.min, humidity?.max, humidity?.unit || "%", 0)}`,
      toneClass: "tone-humidity"
    }),
    renderHighlightCard({
      icon: "uv",
      title: "UV Level",
      value: uvValueText,
      meta: `${uvSourceLabel}. Range ${formatRangeValue(uvIndex?.min, uvIndex?.max, uvIndex?.unit || "index", 1)}`,
      toneClass: "tone-uv"
    }),
    renderHighlightCard({
      icon: "temperature",
      title: "Temperature",
      value: formatRangeValue(temperature?.min, temperature?.max, temperature?.unit || "°C", 0),
      meta: `Average ${formatSingleValue(temperature?.average, temperature?.unit || "°C", 1)}`,
      toneClass: "tone-temperature"
    })
  ];

  weatherMetricsElement.innerHTML = cards.join("");
};

const buildTemperatureTrendSeries = (payload) => {
  const temperatureMetric = payload?.metrics?.temperatureC || {};
  const forecastTemperature = payload?.forecast24h?.temperature || {};

  let low = Number(temperatureMetric?.min);
  let high = Number(temperatureMetric?.max);

  if (!Number.isFinite(low)) {
    low = Number(forecastTemperature?.low);
  }

  if (!Number.isFinite(high)) {
    high = Number(forecastTemperature?.high);
  }

  if (!Number.isFinite(low) && !Number.isFinite(high)) {
    low = 24;
    high = 32;
  } else if (!Number.isFinite(low)) {
    low = high - 5;
  } else if (!Number.isFinite(high)) {
    high = low + 5;
  }

  if (high <= low) {
    high = low + 2.4;
  }

  const average = Number.isFinite(Number(temperatureMetric?.average))
    ? Number(temperatureMetric.average)
    : (low + high) / 2;

  const nowRoundedMs = roundDownToNearestHalfHour(Date.now());
  const forecastWindowStartMs = Number.isFinite(new Date(payload?.forecast24h?.validPeriod?.start).getTime())
    ? roundDownToNearestHalfHour(payload?.forecast24h?.validPeriod?.start)
    : nowRoundedMs;
  const startMs = Math.max(nowRoundedMs, forecastWindowStartMs);

  const pointTimestamps = Array.from({ length: WEATHER_TREND_POINT_COUNT }, (_, index) =>
    startMs + index * WEATHER_TREND_POINT_INTERVAL_MINUTES * 60 * 1000
  );

  const midpoint = (high + low) / 2;
  const amplitude = Math.max((high - low) / 2, 0.8);

  const values = pointTimestamps.map((timestamp) => {
    const timeValue = new Date(timestamp);
    const hourDecimal = timeValue.getHours() + timeValue.getMinutes() / 60;
    const phase = ((hourDecimal - 15) / 24) * Math.PI * 2;
    const estimated = midpoint + amplitude * Math.cos(phase);
    return estimated;
  });

  if (Number.isFinite(average)) {
    const startOffset = average - values[0];
    for (let index = 0; index < values.length; index += 1) {
      const decay = Math.exp(-index / 4.8);
      values[index] += startOffset * decay;
    }
  }

  const conditionText =
    payload?.forecast24h?.generalForecast ||
    payload?.conditions?.[0]?.forecast ||
    payload?.overview?.dominantCondition ||
    "";

  if (/rain|thunder|shower|storm/i.test(conditionText)) {
    for (let index = 0; index < values.length; index += 1) {
      const rainAdjustment = 0.2 + 0.45 * Math.sin((index / (values.length - 1)) * Math.PI);
      values[index] -= rainAdjustment;
    }
  }

  for (let index = 0; index < values.length; index += 1) {
    values[index] = clampNumber(values[index], low, high);
  }

  const labels = pointTimestamps.map((timestamp) => formatTimeLabel(timestamp));

  return {
    labels,
    values: values.map((value) => Number(value.toFixed(1))),
    unit: temperatureMetric?.unit || "°C",
    startMs,
    intervalMinutes: WEATHER_TREND_POINT_INTERVAL_MINUTES,
    conditionText
  };
};

const buildSmoothPath = (points) => {
  if (!points.length) {
    return "";
  }

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = points[index - 1];
    const point = points[index];
    const controlX = (previousPoint.x + point.x) / 2;
    path += ` Q ${controlX} ${previousPoint.y}, ${point.x} ${point.y}`;
  }

  return path;
};

const renderTemperatureTrend = (payload) => {
  if (!weatherTrendChartElement) {
    return;
  }

  const series = buildTemperatureTrendSeries(payload);
  const { values, labels, unit, startMs, intervalMinutes, conditionText } = series;

  if (!values.length) {
    weatherTrendChartElement.innerHTML = `
      <p class="workspace-weather-trend__empty">Temperature outlook is temporarily unavailable.</p>
    `;
    return;
  }

  const chartWidth = 820;
  const chartHeight = 220;
  const paddingLeft = 22;
  const paddingRight = 22;
  const paddingTop = 32;
  const paddingBottom = 44;
  const plotWidth = chartWidth - paddingLeft - paddingRight;
  const plotHeight = chartHeight - paddingTop - paddingBottom;
  const valueMin = Math.min(...values) - 1;
  const valueMax = Math.max(...values) + 1;
  const valueRange = Math.max(valueMax - valueMin, 1);

  const points = values.map((value, index) => {
    const ratio = values.length > 1 ? index / (values.length - 1) : 0;
    const x = paddingLeft + ratio * plotWidth;
    const y = paddingTop + ((valueMax - value) / valueRange) * plotHeight;
    return {
      x,
      y,
      value,
      label: labels[index] || "",
      timestampMs: startMs + index * intervalMinutes * 60 * 1000
    };
  });

  const trendPointStepPx = 34;
  const dynamicChartWidth = Math.max(
    chartWidth,
    paddingLeft + paddingRight + (points.length - 1) * trendPointStepPx
  );
  const dynamicPlotWidth = dynamicChartWidth - paddingLeft - paddingRight;

  for (let index = 0; index < points.length; index += 1) {
    const ratio = points.length > 1 ? index / (points.length - 1) : 0;
    points[index].x = paddingLeft + ratio * dynamicPlotWidth;
  }

  const linePath = buildSmoothPath(points);
  const areaPath = `${linePath} L ${points.at(-1)?.x || 0} ${chartHeight - paddingBottom} L ${
    points[0]?.x || 0
  } ${chartHeight - paddingBottom} Z`;

  const shouldShowDenseLabel = (index) =>
    index === 0 ||
    index === points.length - 1 ||
    index % WEATHER_TREND_LABEL_EVERY_POINTS === 0;

  const shouldShowWeatherSymbol = (index) =>
    index === 0 ||
    index === points.length - 1 ||
    index % WEATHER_TREND_ICON_EVERY_POINTS === 0;

  const gridLinesMarkup = points
    .filter((_, index) => shouldShowDenseLabel(index))
    .map(
      (point) => `
        <line x1="${point.x}" y1="${paddingTop}" x2="${point.x}" y2="${
          chartHeight - paddingBottom
        }" />
      `
    )
    .join("");

  const pointLabelsMarkup = points
    .filter((_, index) => shouldShowDenseLabel(index))
    .map(
      (point) => `
        <text x="${point.x}" y="${point.y - 12}" text-anchor="middle">${escapeHtml(
          formatNumber(point.value, 0) || "--"
        )}°</text>
      `
    )
    .join("");

  const axisLabelsMarkup = points
    .filter((_, index) => shouldShowDenseLabel(index))
    .map(
      (point) => `
        <text x="${point.x}" y="${chartHeight - 13}" text-anchor="middle">${escapeHtml(
          point.label
        )}</text>
      `
    )
    .join("");

  const weatherSymbolsMarkup = points
    .filter((_, index) => shouldShowWeatherSymbol(index))
    .map(
      (point) => `
        <text x="${point.x}" y="${paddingTop - 10}" text-anchor="middle">${escapeHtml(
          resolveTrendWeatherSymbol(point.timestampMs, conditionText)
        )}</text>
      `
    )
    .join("");

  weatherTrendChartElement.innerHTML = `
    <div class="workspace-weather-trend__legend" aria-hidden="true">
      <span>☀ Sun</span>
      <span>☁ Cloud</span>
      <span>🌧 Rain</span>
    </div>
    <div class="workspace-weather-trend__scroll" role="region" aria-label="24-hour temperature trend">
      <svg
        class="workspace-weather-trend-svg"
        viewBox="0 0 ${dynamicChartWidth} ${chartHeight}"
        role="img"
        aria-label="Temperature outlook"
        preserveAspectRatio="xMinYMid meet"
        style="width: ${dynamicChartWidth}px"
      >
      <defs>
        <linearGradient id="weather-trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(56, 189, 248, 0.32)" />
          <stop offset="100%" stop-color="rgba(56, 189, 248, 0.02)" />
        </linearGradient>
      </defs>
      <g class="workspace-weather-trend-svg__grid">${gridLinesMarkup}</g>
      <path class="workspace-weather-trend-svg__area" d="${areaPath}" />
      <path class="workspace-weather-trend-svg__line" d="${linePath}" />
      <g class="workspace-weather-trend-svg__value-labels">${pointLabelsMarkup}</g>
      <g class="workspace-weather-trend-svg__weather-symbols">${weatherSymbolsMarkup}</g>
      <g class="workspace-weather-trend-svg__axis-labels">${axisLabelsMarkup}</g>
      </svg>
    </div>
  `;

  if (weatherTrendSubElement) {
    weatherTrendSubElement.textContent = `Next ${WEATHER_TREND_LOOKAHEAD_HOURS}h at ${intervalMinutes}-min intervals from ${formatTimeLabel(
      startMs
    )}. Estimated range ${formatNumber(Math.min(...values), 0)}° to ${formatNumber(
      Math.max(...values),
      0
    )}° (${unit}).`;
  }
};

const renderWeatherDashboard = (payload, options = {}) => {
  const noticeText = options.noticeText || "";
  const referenceSource = options.referenceSource || "default";

  renderShowcase(payload, referenceSource);
  renderHighlights(payload);
  renderTemperatureTrend(payload);
  setWeatherNotice(noticeText);
};

const renderWeatherFailure = (message) => {
  if (weatherNowTempElement) {
    weatherNowTempElement.innerHTML = `--<span>°C</span>`;
  }

  if (weatherNowConditionElement) {
    weatherNowConditionElement.textContent = "Weather data unavailable";
  }

  if (weatherNowLocationElement) {
    weatherNowLocationElement.textContent = "Please try again in a moment.";
  }

  if (weatherForecastCardsElement) {
    weatherForecastCardsElement.innerHTML = `
      <article class="workspace-weather-forecast-card" role="listitem">
        <div class="workspace-weather-forecast-card__icon">${getForecastIconMarkup("Cloudy")}</div>
        <p class="workspace-weather-forecast-card__temp">--</p>
        <p class="workspace-weather-forecast-card__day">No forecast</p>
        <p class="workspace-weather-forecast-card__date">Temporarily unavailable</p>
      </article>
    `;
  }

  if (weatherMetricsElement) {
    weatherMetricsElement.innerHTML = `
      <article class="workspace-weather-highlight-card is-empty" role="listitem">
        <p class="workspace-weather-highlight-card__title">Weather highlights unavailable</p>
        <p class="workspace-weather-highlight-card__meta">Live feed could not be loaded.</p>
      </article>
    `;
  }

  if (weatherTrendChartElement) {
    weatherTrendChartElement.innerHTML = `
      <p class="workspace-weather-trend__empty">Temperature outlook is unavailable.</p>
    `;
  }

  if (weatherMetaElement) {
    weatherMetaElement.textContent = "Forecast window unavailable";
  }

  if (weatherUpdatedElement) {
    weatherUpdatedElement.textContent = "Weather feed reconnecting...";
  }

  if (weatherTrendSubElement) {
    weatherTrendSubElement.textContent = "Estimated line will appear after the next successful update.";
  }

  setWeatherNotice(message);
};

const refreshWeatherDashboard = async () => {
  if (!weatherSectionElement) {
    return;
  }

  const requestSequence = ++weatherRenderSequence;
  const referenceCenter = getReferenceCenter();
  setWeatherReferenceLabel(referenceCenter.source);

  const query = new URLSearchParams({
    lat: referenceCenter.lat.toFixed(6),
    lng: referenceCenter.lng.toFixed(6)
  });

  try {
    const payload = await fetchJson(`/api/weather/summary?${query.toString()}`);

    if (requestSequence !== weatherRenderSequence) {
      return;
    }

    weatherLastSuccessfulState = {
      payload,
      source: referenceCenter.source
    };

    setWeatherReferenceLabel(referenceCenter.source);
    renderWeatherDashboard(payload, {
      referenceSource: referenceCenter.source,
      noticeText: payload?.partial
        ? "Some feeds are delayed. Showing the best available snapshot."
        : ""
    });
  } catch (error) {
    console.error("Weather dashboard refresh failed.", error);

    if (requestSequence !== weatherRenderSequence) {
      return;
    }

    if (weatherLastSuccessfulState?.payload) {
      const fallbackSource = weatherLastSuccessfulState.source || referenceCenter.source;
      setWeatherReferenceLabel(fallbackSource);
      renderWeatherDashboard(weatherLastSuccessfulState.payload, {
        referenceSource: fallbackSource,
        noticeText: "Live weather feed is delayed. Showing latest available snapshot."
      });
      return;
    }

    renderWeatherFailure("Weather data could not be loaded right now.");
  }
};

const scheduleWeatherRefresh = () => {
  window.clearTimeout(weatherRefreshTimerId);
  weatherRefreshTimerId = window.setTimeout(async () => {
    await refreshWeatherDashboard();
    scheduleWeatherRefresh();
  }, WEATHER_REFRESH_INTERVAL_MS);
};

const stopWeatherRefresh = () => {
  window.clearTimeout(weatherRefreshTimerId);
};

const updateUserLocation = (position) => {
  const latitude = Number(position?.coords?.latitude);
  const longitude = Number(position?.coords?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return;
  }

  weatherUserLocation = {
    lat: latitude,
    lng: longitude,
    accuracyMeters: Number(position?.coords?.accuracy) || null
  };

  void refreshWeatherDashboard();
};

const requestUserLocation = () => {
  if (!navigator.geolocation) {
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      updateUserLocation(position);
    },
    (error) => {
      console.warn("Weather user location could not be resolved.", error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: USER_LOCATION_MAX_AGE_MS,
      timeout: USER_LOCATION_TIMEOUT_MS
    }
  );
};

const initializeWeatherDashboard = async () => {
  if (!weatherSectionElement) {
    return;
  }

  if (weatherDashboardInitialized) {
    await refreshWeatherDashboard();
    scheduleWeatherRefresh();
    return;
  }

  weatherDashboardInitialized = true;
  requestUserLocation();
  await refreshWeatherDashboard();
  scheduleWeatherRefresh();
};

const handleWorkspaceViewChange = (event) => {
  const viewName = event?.detail?.viewName;

  if (viewName !== "weather") {
    stopWeatherRefresh();
    return;
  }

  requestUserLocation();
  void initializeWeatherDashboard();
};

window.addEventListener("workspace:viewchange", handleWorkspaceViewChange);

const LIBRARIES_SECTION_ID = "workspace-libraries";
const LIBRARIES_SUMMARY_ID = "workspace-libraries-summary";
const LIBRARIES_GRID_ID = "workspace-libraries-grid";
const LIBRARIES_SEARCH_ID = "workspace-libraries-search";
const LIBRARIES_REFRESH_ID = "workspace-libraries-refresh";
const LIBRARIES_STATUS_ID = "workspace-libraries-status";

const librariesSectionElement = document.querySelector(`#${LIBRARIES_SECTION_ID}`);
const librariesSummaryElement = document.querySelector(`#${LIBRARIES_SUMMARY_ID}`);
const librariesGridElement = document.querySelector(`#${LIBRARIES_GRID_ID}`);
const librariesSearchElement = document.querySelector(`#${LIBRARIES_SEARCH_ID}`);
const librariesRefreshButton = document.querySelector(`#${LIBRARIES_REFRESH_ID}`);
const librariesStatusElement = document.querySelector(`#${LIBRARIES_STATUS_ID}`);

let librariesDashboardInitialized = false;
let libraryOccupancyState = [];
let libraryPayloadMeta = null;

const LIBRARY_CARD_CONFIG = {
  "lee-wee-nam-library": {
    image: "./images/libraries/lwn.jpg",
    imageClass: "",
    order: 1
  },
  "business-library": {
    image: "./images/libraries/business.jpg",
    imageClass: "",
    order: 2
  },
  "humanities-social-sciences-library": {
    image: "./images/libraries/hss.jpg",
    imageClass: "workspace-library-card__image--hss",
    order: 3
  },
  "chinese-library": {
    image: "./images/libraries/chinese.jpeg",
    imageClass: "workspace-library-card__image--chinese",
    order: 4
  },
  "art-design-media-library": {
    image: "./images/libraries/adm.jpg",
    imageClass: "",
    order: 5
  },
  "communication-information-library": {
    image: "./images/libraries/communication.jpg",
    imageClass: "",
    order: 6
  }
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

const formatNumber = (value) =>
  Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 0
  });

const getOccupancyTone = (occupancyRate) => {
  const normalizedRate = Number(occupancyRate);

  if (!Number.isFinite(normalizedRate)) {
    return "unknown";
  }

  if (normalizedRate >= 80) {
    return "busy";
  }

  if (normalizedRate >= 50) {
    return "moderate";
  }

  return "open";
};

const getAvailabilityLabel = (library) => {
  const availableSeats = Number(library?.availableSeats);
  const totalSeats = Number(library?.totalSeats);

  if (!Number.isFinite(availableSeats) || !Number.isFinite(totalSeats) || totalSeats <= 0) {
    return "Seats unavailable";
  }

  return `${formatNumber(Math.max(availableSeats, 0))} available`;
};

const normalizeLibrary = (library) => {
  const totalSeats = Math.max(Number(library?.totalSeats) || 0, 0);
  const occupiedSeats = Math.min(Math.max(Number(library?.occupiedSeats) || 0, 0), totalSeats);
  const rawAvailableSeats = Number(library?.availableSeats);
  const rawOccupancyRate = Number(library?.occupancyRate);
  const availableSeats = Math.min(
    Math.max(Number.isFinite(rawAvailableSeats) ? rawAvailableSeats : totalSeats - occupiedSeats, 0),
    totalSeats
  );
  const occupancyRate = Math.min(
    Math.max(
      Number.isFinite(rawOccupancyRate)
        ? rawOccupancyRate
        : Math.round((occupiedSeats / Math.max(totalSeats, 1)) * 100),
      0
    ),
    100
  );

  return {
    id: String(library?.id || "").trim(),
    name: String(library?.name || "NTU Library").trim(),
    location: String(library?.location || "Location unavailable").trim(),
    totalSeats,
    occupiedSeats,
    availableSeats,
    occupancyRate,
    lastUpdated: String(library?.lastUpdated || "").trim()
  };
};

const getFilteredLibraries = () => {
  const query = String(librariesSearchElement?.value || "").trim().toLowerCase();
  const visibleLibraries = libraryOccupancyState
    .filter((library) => LIBRARY_CARD_CONFIG[library.id])
    .sort(
      (firstLibrary, secondLibrary) =>
        LIBRARY_CARD_CONFIG[firstLibrary.id].order - LIBRARY_CARD_CONFIG[secondLibrary.id].order
    );

  if (!query) {
    return visibleLibraries;
  }

  return visibleLibraries.filter((library) =>
    `${library.name} ${library.location}`.toLowerCase().includes(query)
  );
};

const renderSummary = (libraries) => {
  if (!librariesSummaryElement) {
    return;
  }

  const totalAvailableSeats = libraries.reduce(
    (sum, library) => sum + Number(library.availableSeats || 0),
    0
  );
  const totalSeats = libraries.reduce((sum, library) => sum + Number(library.totalSeats || 0), 0);
  const averageOccupancy = libraries.length
    ? Math.round(
        libraries.reduce((sum, library) => sum + Number(library.occupancyRate || 0), 0) /
          libraries.length
      )
    : 0;
  const bestAvailability = libraries.reduce((bestLibrary, library) => {
    if (!bestLibrary || Number(library.availableSeats) > Number(bestLibrary.availableSeats)) {
      return library;
    }

    return bestLibrary;
  }, null);

  librariesSummaryElement.innerHTML = `
    <article class="workspace-libraries-summary-card">
      <span class="workspace-libraries-summary-card__label">Available Seats</span>
      <strong class="workspace-libraries-summary-card__value">${formatNumber(totalAvailableSeats)}</strong>
      <span class="workspace-libraries-summary-card__meta">${formatNumber(totalSeats)} total seats</span>
    </article>
    <article class="workspace-libraries-summary-card">
      <span class="workspace-libraries-summary-card__label">Average Occupancy</span>
      <strong class="workspace-libraries-summary-card__value">${formatNumber(averageOccupancy)}%</strong>
      <span class="workspace-libraries-summary-card__meta">${formatNumber(libraries.length)} locations shown</span>
    </article>
    <article class="workspace-libraries-summary-card">
      <span class="workspace-libraries-summary-card__label">Most Seats Open</span>
      <strong class="workspace-libraries-summary-card__value workspace-libraries-summary-card__value--name">
        ${escapeHtml(bestAvailability?.name || "Unavailable")}
      </strong>
      <span class="workspace-libraries-summary-card__meta">
        ${escapeHtml(bestAvailability ? getAvailabilityLabel(bestAvailability) : "No libraries shown")}
      </span>
    </article>
  `;
};

const renderLibraryCards = (libraries) => {
  if (!librariesGridElement) {
    return;
  }

  if (!libraries.length) {
    librariesGridElement.innerHTML = `
      <p class="workspace-libraries__empty">No libraries match this search.</p>
    `;
    return;
  }

  librariesGridElement.innerHTML = libraries
    .map((library) => {
      const occupancyRate = Math.round(Number(library.occupancyRate || 0));
      const tone = getOccupancyTone(occupancyRate);
      const cardConfig = LIBRARY_CARD_CONFIG[library.id] || {};

      return `
        <article
          class="workspace-library-card tone-${tone}"
          role="listitem"
        >
          <img
            class="workspace-library-card__image ${escapeHtml(cardConfig.imageClass || "")}"
            src="${escapeHtml(cardConfig.image || "./images/libraries/lwn.jpg")}"
            alt="${escapeHtml(library.name)}"
            loading="lazy"
          />

          <div class="workspace-library-card__content">
            <header class="workspace-library-card__header">
              <h2 class="workspace-library-card__title">${escapeHtml(library.name)}</h2>
            </header>

            <div class="workspace-library-card__capacity">
              <span class="workspace-library-card__capacity-label">Capacity: ${formatNumber(occupancyRate)}%</span>
              <progress
                class="workspace-library-card__progress-track"
                value="${occupancyRate}"
                max="100"
                aria-label="${escapeHtml(library.name)} is ${formatNumber(occupancyRate)}% occupied"
              >
                ${formatNumber(occupancyRate)}%
              </progress>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
};

const setLibrariesStatus = (message, tone = "info") => {
  if (!librariesStatusElement) {
    return;
  }

  librariesStatusElement.textContent = message;
  librariesStatusElement.setAttribute("data-tone", tone);
};

const renderLibrariesDashboard = () => {
  const filteredLibraries = getFilteredLibraries();

  renderSummary(filteredLibraries);
  renderLibraryCards(filteredLibraries);
  setLibrariesStatus("");
};

const refreshLibrariesDashboard = async () => {
  if (!librariesSectionElement) {
    return;
  }

  if (librariesRefreshButton) {
    librariesRefreshButton.disabled = true;
  }

  setLibrariesStatus("Refreshing library seats...");

  try {
    const payload = await fetchJson("/api/libraries/occupancy");
    const libraries = Array.isArray(payload?.libraries) ? payload.libraries : [];

    libraryOccupancyState = libraries.map(normalizeLibrary);
    libraryPayloadMeta = {
      source: payload?.source || "unknown",
      prototype: Boolean(payload?.prototype),
      generatedAt: payload?.generatedAt || ""
    };

    renderLibrariesDashboard();
  } catch (error) {
    console.error("Library occupancy refresh failed.", error);
    setLibrariesStatus("Library seat data could not be loaded right now.", "error");

    if (librariesGridElement && !libraryOccupancyState.length) {
      librariesGridElement.innerHTML = `
        <p class="workspace-libraries__empty">Library seat data is temporarily unavailable.</p>
      `;
    }
  } finally {
    if (librariesRefreshButton) {
      librariesRefreshButton.disabled = false;
    }
  }
};

const initializeLibrariesDashboard = async () => {
  if (!librariesSectionElement) {
    return;
  }

  if (librariesDashboardInitialized) {
    renderLibrariesDashboard();
    return;
  }

  librariesDashboardInitialized = true;
  await refreshLibrariesDashboard();
};

librariesSearchElement?.addEventListener("input", renderLibrariesDashboard);
librariesRefreshButton?.addEventListener("click", refreshLibrariesDashboard);

window.addEventListener("workspace:viewchange", (event) => {
  if (event?.detail?.viewName !== "libraries") {
    return;
  }

  void initializeLibrariesDashboard();
});

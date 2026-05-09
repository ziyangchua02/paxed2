const ROOMS_MAP_CONTAINER_ID = "workspace-rooms-map";
const ROOMS_SECTION_ID = "workspace-rooms";
const ROOMS_LIST_ID = "workspace-rooms-list";
const ROOMS_SEARCH_ID = "workspace-rooms-search";
const ROOMS_DETAILS_ID = "workspace-room-details";
const ROOMS_LOCATE_ID = "workspace-rooms-locate";
const USER_LOCATION_MAX_AGE_MS = 60_000;
const USER_LOCATION_TIMEOUT_MS = 9_000;
const DEFAULT_MAZEMAP_URL =
  "https://use.mazemap.com/?config=ntu-sg&campusid=2123&center=103.681800,1.345700&zoom=16&positioning=true";

const roomsSectionElement = document.querySelector(`#${ROOMS_SECTION_ID}`);
const roomsMapElement = document.querySelector(`#${ROOMS_MAP_CONTAINER_ID}`);
const roomsListElement = document.querySelector(`#${ROOMS_LIST_ID}`);
const roomsSearchElement = document.querySelector(`#${ROOMS_SEARCH_ID}`);
const roomsDetailsElement = document.querySelector(`#${ROOMS_DETAILS_ID}`);
const roomsLocateButton = document.querySelector(`#${ROOMS_LOCATE_ID}`);

let roomsMapFrame = null;
let roomsMapInitialized = false;
let roomsDataset = [];
let selectedRoomId = "";
let userLocation = null;
let directionsSequence = 0;
let activeMazeMapUrl = "";

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

const formatDistanceLabel = (distanceMeters) => {
  const value = Number(distanceMeters);

  if (!Number.isFinite(value)) {
    return "Distance pending";
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)} km`;
  }

  return `${Math.max(Math.round(value / 10) * 10, 10)} m`;
};

const formatWalkingTimeLabel = (durationSeconds) => {
  const value = Number(durationSeconds);

  if (!Number.isFinite(value)) {
    return "Walking time pending";
  }

  const minutes = Math.max(Math.round(value / 60), 1);
  return minutes <= 1 ? "1 min walk" : `${minutes} min walk`;
};

const getRoomSearchText = (room) =>
  [
    room?.code,
    room?.name,
    room?.building,
    room?.zone,
    room?.floor,
    ...(Array.isArray(room?.aliases) ? room.aliases : [])
  ]
    .join(" ")
    .toLowerCase();

const getFilteredRooms = () => {
  const query = String(roomsSearchElement?.value || "").trim().toLowerCase();

  if (!query) {
    return roomsDataset;
  }

  return roomsDataset.filter((room) => getRoomSearchText(room).includes(query));
};

const getDestinationUrl = (room) => {
  if (room?.mazeMapNavigationUrl) {
    return room.mazeMapNavigationUrl;
  }

  if (room?.mazeMapUrl) {
    return room.mazeMapUrl;
  }

  const params = new URLSearchParams({
    api: "1",
    destination: `${Number(room.lat).toFixed(6)},${Number(room.lng).toFixed(6)}`,
    travelmode: "walking"
  });

  return `https://www.google.com/maps/dir/?${params.toString()}`;
};

const getEmbeddedMazeMapUrl = (room, route = null) =>
  route?.mazeMapNavigationUrl ||
  room?.mazeMapNavigationUrl ||
  room?.mazeMapUrl ||
  DEFAULT_MAZEMAP_URL;

const syncEmbeddedMazeMap = (room = null, route = null) => {
  if (!roomsMapElement) {
    return;
  }

  const nextUrl = getEmbeddedMazeMapUrl(room, route);

  if (!roomsMapFrame) {
    roomsMapFrame = document.createElement("iframe");
    roomsMapFrame.className = "workspace-room-mazemap-frame";
    roomsMapFrame.title = "NTU MazeMap room navigation";
    roomsMapFrame.loading = "lazy";
    roomsMapFrame.referrerPolicy = "origin";
    roomsMapFrame.allow = "geolocation";
    roomsMapElement.replaceChildren(roomsMapFrame);
  }

  if (nextUrl !== activeMazeMapUrl) {
    roomsMapFrame.src = nextUrl;
    activeMazeMapUrl = nextUrl;
  }
};

const renderRoomList = () => {
  if (!roomsListElement) {
    return;
  }

  const rooms = getFilteredRooms();

  if (!rooms.length) {
    roomsListElement.innerHTML = `
      <p class="workspace-drive__empty">No matching tutorial rooms. Try TR, South Spine, SHHK, or The Arc.</p>
    `;
    return;
  }

  roomsListElement.innerHTML = rooms
    .map((room) => {
      const selectedClass = room.id === selectedRoomId ? " is-selected" : "";

      return `
        <article class="workspace-nearest-card workspace-room-card${selectedClass}" role="listitem" data-room-id="${escapeHtml(room.id)}">
          <div class="workspace-nearest-card__header">
            <span class="workspace-nearest-card__service">${escapeHtml(room.code)}</span>
            <span class="workspace-nearest-card__distance">${escapeHtml(room.floor)}</span>
          </div>
          <p class="workspace-nearest-card__stop">${escapeHtml(room.name)}</p>
          <p class="workspace-nearest-card__meta">${escapeHtml(room.building)} - ${escapeHtml(room.zone)}</p>
        </article>
      `;
    })
    .join("");
};

const renderDetails = (
  room,
  {
    route = null,
    routeStatus = userLocation
      ? "Calculating walking route..."
      : "Enable location to estimate walking time from where you are."
  } = {}
) => {
  if (!roomsDetailsElement) {
    return;
  }

  if (!room) {
    roomsDetailsElement.innerHTML = `
      <p class="workspace-drive-details__empty">
        Select a tutorial room to view location and walking directions.
      </p>
    `;
    return;
  }

  const directionsUrl =
    route?.mazeMapNavigationUrl ||
    room?.mazeMapNavigationUrl ||
    route?.mazeMapUrl ||
    room?.mazeMapUrl ||
    route?.googleMapsUrl ||
    getDestinationUrl(room);
  const directionsLabel =
    route?.mazeMapNavigationUrl || room?.mazeMapNavigationUrl
      ? "Open full map"
      : "Open directions";
  const distanceLabel = route ? formatDistanceLabel(route.distanceMeters) : "Select location";
  const timeLabel = route ? formatWalkingTimeLabel(route.durationSeconds) : "Route pending";

  roomsDetailsElement.innerHTML = `
    <div class="workspace-room-details__header">
      <p class="workspace-services__eyebrow">Selected room</p>
      <h3 class="workspace-drive-details__title">${escapeHtml(room.code)}</h3>
      <p class="workspace-drive-details__subtitle">${escapeHtml(room.name)} - ${escapeHtml(room.building)}</p>
    </div>
    <div class="workspace-room-details__metrics">
      <section class="workspace-drive-details__metric">
        <span class="workspace-drive-details__metric-label">Floor</span>
        <strong class="workspace-drive-details__metric-value">${escapeHtml(room.floor)}</strong>
      </section>
      <section class="workspace-drive-details__metric">
        <span class="workspace-drive-details__metric-label">Walk</span>
        <strong class="workspace-drive-details__metric-value">${escapeHtml(timeLabel)}</strong>
      </section>
      <section class="workspace-drive-details__metric">
        <span class="workspace-drive-details__metric-label">Distance</span>
        <strong class="workspace-drive-details__metric-value">${escapeHtml(distanceLabel)}</strong>
      </section>
    </div>
    <p class="workspace-room-details__route">${escapeHtml(routeStatus)}</p>
    <a
      class="workspace-room-details__directions"
      href="${escapeHtml(directionsUrl)}"
      target="_blank"
      rel="noopener noreferrer"
    >
      ${escapeHtml(directionsLabel)}
    </a>
  `;
};

const updateRoomDirections = async (room) => {
  const requestSequence = ++directionsSequence;

  if (!room) {
    syncEmbeddedMazeMap(null);
    renderDetails(null);
    return;
  }

  if (!userLocation) {
    syncEmbeddedMazeMap(room);
    renderDetails(room, {
      routeStatus: "Indoor room navigation is loaded on the map. Enable location for a route from where you are."
    });
    return;
  }

  syncEmbeddedMazeMap(room);
  renderDetails(room, {
    routeStatus: "Calculating walking route from your location..."
  });

  const query = new URLSearchParams({
    roomId: room.id,
    fromLat: userLocation.lat.toFixed(6),
    fromLng: userLocation.lng.toFixed(6)
  });

  try {
    const route = await fetchJson(`/api/map/tutorial-room-directions?${query.toString()}`);

    if (requestSequence !== directionsSequence) {
      return;
    }

    syncEmbeddedMazeMap(route.room || room, route);
    renderDetails(room, {
      route,
      routeStatus: "Indoor route is loaded on the map with your location as the start."
    });
  } catch (error) {
    console.error("Tutorial room directions failed.", error);

    if (requestSequence !== directionsSequence) {
      return;
    }

    syncEmbeddedMazeMap(room);
    renderDetails(room, {
      routeStatus: "Indoor destination is loaded on the map. Walking estimate is unavailable."
    });
  }
};

const selectRoom = (roomId) => {
  const room = roomsDataset.find((entry) => entry.id === roomId);

  if (!room) {
    return;
  }

  selectedRoomId = room.id;
  renderRoomList();
  void updateRoomDirections(room);
};

const requestUserLocation = () => {
  if (!navigator.geolocation) {
    if (roomsLocateButton) {
      roomsLocateButton.textContent = "Location unavailable";
    }
    return;
  }

  if (roomsLocateButton) {
    roomsLocateButton.disabled = true;
    roomsLocateButton.textContent = "Locating...";
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latitude = Number(position?.coords?.latitude);
      const longitude = Number(position?.coords?.longitude);

      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        userLocation = {
          lat: latitude,
          lng: longitude,
          accuracyMeters: Number(position?.coords?.accuracy) || null
        };

        const selectedRoom = roomsDataset.find((room) => room.id === selectedRoomId);
        void updateRoomDirections(selectedRoom);
      }

      if (roomsLocateButton) {
        roomsLocateButton.disabled = false;
        roomsLocateButton.textContent = "Use my location";
      }
    },
    (error) => {
      console.warn("Tutorial room user location could not be resolved.", error);

      if (roomsLocateButton) {
        roomsLocateButton.disabled = false;
        roomsLocateButton.textContent = "Use my location";
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: USER_LOCATION_MAX_AGE_MS,
      timeout: USER_LOCATION_TIMEOUT_MS
    }
  );
};

const setupRoomsInteractions = () => {
  if (roomsListElement) {
    roomsListElement.addEventListener("click", (event) => {
      const roomCard = event.target?.closest?.("[data-room-id]");

      if (!roomCard) {
        return;
      }

      selectRoom(roomCard.dataset.roomId);
    });
  }

  if (roomsSearchElement) {
    roomsSearchElement.addEventListener("input", () => {
      renderRoomList();
    });
  }

  if (roomsLocateButton) {
    roomsLocateButton.addEventListener("click", () => {
      requestUserLocation();
    });
  }
};

const resyncRoomsMapLayout = () => {
  // The embedded MazeMap frame resizes with CSS; no Leaflet invalidation needed here.
};

const initializeRoomsMap = async () => {
  if (!roomsSectionElement || !roomsMapElement) {
    return;
  }

  if (roomsMapInitialized) {
    resyncRoomsMapLayout();
    return;
  }

  try {
    setupRoomsInteractions();
    syncEmbeddedMazeMap(null);

    if (!roomsListElement && !roomsDetailsElement) {
      roomsMapInitialized = true;
      resyncRoomsMapLayout();
      return;
    }

    const payload = await fetchJson("/api/map/tutorial-rooms");

    roomsDataset = Array.isArray(payload?.rooms) ? payload.rooms : [];
    selectedRoomId = "";

    renderRoomList();
    renderDetails(null);
    roomsMapInitialized = true;
    resyncRoomsMapLayout();
  } catch (error) {
    console.error("Tutorial room map bootstrap failed.", error);

    if (roomsListElement) {
      roomsListElement.innerHTML = `
        <p class="workspace-drive__empty">Tutorial room map could not be initialized right now.</p>
      `;
    }
  }
};

const handleWorkspaceViewChange = (event) => {
  if (event?.detail?.viewName !== "rooms") {
    return;
  }

  void initializeRoomsMap().then(() => {
    resyncRoomsMapLayout();
  });
};

window.addEventListener("workspace:viewchange", handleWorkspaceViewChange);

if (document.body.classList.contains("is-rooms-view")) {
  void initializeRoomsMap().then(() => {
    resyncRoomsMapLayout();
  });
}

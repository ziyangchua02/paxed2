import { firebaseConfig } from "./firebase-config.js";

const signOutButton = document.querySelector("#workspace-signout");
const statusElement = document.querySelector("#workspace-status");
const busesViewButton = document.querySelector("#workspace-view-buses");
const driveViewButton = document.querySelector("#workspace-view-drive");
const weatherViewButton = document.querySelector("#workspace-view-weather");
const roomsViewButton = document.querySelector("#workspace-view-rooms");
const librariesViewButton = document.querySelector("#workspace-view-libraries");
const busDashboardElement = document.querySelector("#workspace-buses");
const driveDashboardElement = document.querySelector("#workspace-drive");
const weatherDashboardElement = document.querySelector("#workspace-weather");
const roomsDashboardElement = document.querySelector("#workspace-rooms");
const librariesDashboardElement = document.querySelector("#workspace-libraries");
const mobilePanelQuery = window.matchMedia("(max-width: 680px)");

const AUTH_PAGE_PATH = "./auth.html";
const WORKSPACE_VIEW_TITLES = {
  buses: "Paxed | Workspace",
  drive: "Paxed | Drive",
  weather: "Paxed | Weather",
  rooms: "Paxed | Tutorial Rooms",
  libraries: "Paxed | Our Locations"
};

let auth = null;
let authModule = null;

const setStatus = (message, tone = "info") => {
  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;
  statusElement.setAttribute("data-tone", tone);
};

const hasFirebaseConfig = () =>
  Object.values(firebaseConfig).every(
    (value) => typeof value === "string" && value.trim() && !value.startsWith("REPLACE_WITH_")
  );

const redirectToAuthPage = () => {
  window.location.replace(AUTH_PAGE_PATH);
};

const setDashboardView = (viewName = "buses") => {
  const normalizedViewName =
    viewName === "drive" ||
    viewName === "weather" ||
    viewName === "rooms" ||
    viewName === "libraries"
      ? viewName
      : "buses";
  const isBusView = normalizedViewName === "buses";
  const isDriveView = normalizedViewName === "drive";
  const isWeatherView = normalizedViewName === "weather";
  const isRoomsView = normalizedViewName === "rooms";
  const isLibrariesView = normalizedViewName === "libraries";

  if (busDashboardElement) {
    busDashboardElement.hidden = !isBusView;
  }

  if (driveDashboardElement) {
    driveDashboardElement.hidden = !isDriveView;
  }

  if (weatherDashboardElement) {
    weatherDashboardElement.hidden = !isWeatherView;
  }

  if (roomsDashboardElement) {
    roomsDashboardElement.hidden = !isRoomsView;
  }

  if (librariesDashboardElement) {
    librariesDashboardElement.hidden = !isLibrariesView;
  }

  if (busesViewButton) {
    busesViewButton.classList.toggle("is-active", isBusView);
    busesViewButton.setAttribute("aria-pressed", String(isBusView));
  }

  if (driveViewButton) {
    driveViewButton.classList.toggle("is-active", isDriveView);
    driveViewButton.setAttribute("aria-pressed", String(isDriveView));
  }

  if (weatherViewButton) {
    weatherViewButton.classList.toggle("is-active", isWeatherView);
    weatherViewButton.setAttribute("aria-pressed", String(isWeatherView));
  }

  if (roomsViewButton) {
    roomsViewButton.classList.toggle("is-active", isRoomsView);
    roomsViewButton.setAttribute("aria-pressed", String(isRoomsView));
  }

  if (librariesViewButton) {
    librariesViewButton.classList.toggle("is-active", isLibrariesView);
    librariesViewButton.setAttribute("aria-pressed", String(isLibrariesView));
  }

  document.body.classList.toggle("is-bus-view", isBusView);
  document.body.classList.toggle("is-drive-view", isDriveView);
  document.body.classList.toggle("is-weather-view", isWeatherView);
  document.body.classList.toggle("is-rooms-view", isRoomsView);
  document.body.classList.toggle("is-libraries-view", isLibrariesView);
  document.title = WORKSPACE_VIEW_TITLES[normalizedViewName] || WORKSPACE_VIEW_TITLES.buses;

  setStatus("");

  window.dispatchEvent(
    new CustomEvent("workspace:viewchange", {
      detail: {
        viewName: normalizedViewName
      }
    })
  );

  window.setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 120);
};

const setupDashboardViewSwitcher = () => {
  if (
    !busesViewButton ||
    !driveViewButton ||
    !weatherViewButton ||
    !roomsViewButton ||
    !librariesViewButton
  ) {
    return;
  }

  busesViewButton.addEventListener("click", () => {
    setDashboardView("buses");
  });

  driveViewButton.addEventListener("click", () => {
    setDashboardView("drive");
  });

  weatherViewButton.addEventListener("click", () => {
    setDashboardView("weather");
  });

  roomsViewButton.addEventListener("click", () => {
    setDashboardView("rooms");
  });

  librariesViewButton.addEventListener("click", () => {
    setDashboardView("libraries");
  });

  setDashboardView("buses");
};

const setupAuthStateGuard = () => {
  authModule.onAuthStateChanged(auth, (user) => {
    if (!user) {
      redirectToAuthPage();
      return;
    }

    setStatus("");
  });
};

const setupSignOut = () => {
  signOutButton.addEventListener("click", async () => {
    if (!auth || !authModule) {
      return;
    }

    signOutButton.disabled = true;
    setStatus("Signing out...");

    try {
      await authModule.signOut(auth);
      redirectToAuthPage();
    } catch (error) {
      signOutButton.disabled = false;
      console.error("Failed to sign out from workspace.", error);
      setStatus("Could not sign out. Try again.", "error");
    }
  });
};

const setupMobilePanelToggles = () => {
  const collapsibleSections = [
    ...document.querySelectorAll("[data-mobile-collapsible]")
  ];

  if (!collapsibleSections.length) {
    return;
  }

  const setSectionExpanded = (section, expanded) => {
    const toggleButton = section.querySelector("[data-mobile-panel-toggle]");
    const contentId = toggleButton?.getAttribute("data-panel-content-id");
    const contentElement = contentId ? document.getElementById(contentId) : null;

    section.classList.toggle("is-collapsed", !expanded);

    if (toggleButton) {
      toggleButton.setAttribute("aria-expanded", String(expanded));
      toggleButton.textContent = expanded ? "Hide" : "Show";
    }

    if (contentElement) {
      contentElement.hidden = !expanded;
    }
  };

  const syncPanelState = () => {
    if (!mobilePanelQuery.matches) {
      collapsibleSections.forEach((section) => {
        setSectionExpanded(section, true);
      });
      return;
    }

    const defaultSection =
      collapsibleSections.find((section) => section.id === "workspace-nearest") ||
      collapsibleSections[0];

    collapsibleSections.forEach((section, index) => {
      setSectionExpanded(section, section === defaultSection || (!defaultSection && index === 0));
    });
  };

  collapsibleSections.forEach((section) => {
    const toggleButton = section.querySelector("[data-mobile-panel-toggle]");

    if (!toggleButton) {
      return;
    }

    toggleButton.addEventListener("click", () => {
      if (!mobilePanelQuery.matches) {
        return;
      }

      const isExpanded = toggleButton.getAttribute("aria-expanded") === "true";

      if (isExpanded) {
        setSectionExpanded(section, false);
        return;
      }

      collapsibleSections.forEach((panelSection) => {
        setSectionExpanded(panelSection, panelSection === section);
      });
    });
  });

  if (typeof mobilePanelQuery.addEventListener === "function") {
    mobilePanelQuery.addEventListener("change", syncPanelState);
  } else {
    mobilePanelQuery.addListener(syncPanelState);
  }

  syncPanelState();
};

const bootstrap = async () => {
  if (!signOutButton) {
    return;
  }

  setupMobilePanelToggles();

  if (!hasFirebaseConfig()) {
    setStatus("Firebase config missing. Returning to auth page.", "error");
    redirectToAuthPage();
    return;
  }

  try {
    const [{ getApp, getApps, initializeApp }, loadedAuthModule] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js")
    ]);

    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

    authModule = loadedAuthModule;
    auth = authModule.getAuth(app);

    setupDashboardViewSwitcher();
    setupSignOut();
    setupAuthStateGuard();
  } catch (error) {
    console.error("Failed to initialize workspace auth guard.", error);
    setStatus("Could not initialize workspace session.", "error");
    redirectToAuthPage();
  }
};

bootstrap();

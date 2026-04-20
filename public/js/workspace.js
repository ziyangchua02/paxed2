import { firebaseConfig } from "./firebase-config.js";

const signOutButton = document.querySelector("#workspace-signout");
const statusElement = document.querySelector("#workspace-status");
const busesViewButton = document.querySelector("#workspace-view-buses");
const driveViewButton = document.querySelector("#workspace-view-drive");
const busDashboardElement = document.querySelector("#workspace-buses");
const driveDashboardElement = document.querySelector("#workspace-drive");

const AUTH_PAGE_PATH = "./auth.html";

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
  const isBusView = viewName === "buses";

  if (busDashboardElement) {
    busDashboardElement.hidden = !isBusView;
  }

  if (driveDashboardElement) {
    driveDashboardElement.hidden = isBusView;
  }

  if (busesViewButton) {
    busesViewButton.classList.toggle("is-active", isBusView);
    busesViewButton.setAttribute("aria-pressed", String(isBusView));
  }

  if (driveViewButton) {
    driveViewButton.classList.toggle("is-active", !isBusView);
    driveViewButton.setAttribute("aria-pressed", String(!isBusView));
  }

  document.body.classList.toggle("is-bus-view", isBusView);
  document.body.classList.toggle("is-drive-view", !isBusView);

  setStatus("");

  window.dispatchEvent(
    new CustomEvent("workspace:viewchange", {
      detail: {
        viewName: isBusView ? "buses" : "drive"
      }
    })
  );

  window.setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 120);
};

const setupDashboardViewSwitcher = () => {
  if (!busesViewButton || !driveViewButton) {
    return;
  }

  busesViewButton.addEventListener("click", () => {
    setDashboardView("buses");
  });

  driveViewButton.addEventListener("click", () => {
    setDashboardView("drive");
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

const bootstrap = async () => {
  if (!signOutButton) {
    return;
  }

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

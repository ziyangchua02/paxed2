import { firebaseConfig } from "./firebase-config.js";

const signOutButton = document.querySelector("#workspace-signout");
const statusElement = document.querySelector("#workspace-status");

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

    setupSignOut();
    setupAuthStateGuard();
  } catch (error) {
    console.error("Failed to initialize workspace auth guard.", error);
    setStatus("Could not initialize workspace session.", "error");
    redirectToAuthPage();
  }
};

bootstrap();

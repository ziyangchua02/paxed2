import { firebaseConfig } from "./firebase-config.js";

const authStatus = document.querySelector("#auth-status");
const authPanel = document.querySelector("#auth-panel");
const signedInPanel = document.querySelector("#signed-in-panel");
const userLabel = document.querySelector("#user-label");

const googleLoginButton = document.querySelector("#google-login-button");
const emailAuthForm = document.querySelector("#email-auth-form");
const emailInput = document.querySelector("#email-input");
const passwordInput = document.querySelector("#password-input");
const emailSubmitButton = document.querySelector("#email-submit-button");
const switchModeButton = document.querySelector("#switch-mode-button");
const resetPasswordButton = document.querySelector("#reset-password-button");
const signOutButton = document.querySelector("#sign-out-button");

const WORKSPACE_PAGE_PATH = "./workspace.html";

let hasNavigatedToWorkspace = false;

const state = {
  mode: "sign-in",
  ready: false,
  busy: false,
  auth: null,
  authModule: null,
  provider: null
};

const setStatus = (message, tone = "info") => {
  if (!authStatus) {
    return;
  }

  authStatus.textContent = message;
  authStatus.setAttribute("data-tone", tone);
};

const hasFirebaseConfig = () =>
  Object.values(firebaseConfig).every(
    (value) => typeof value === "string" && value.trim() && !value.startsWith("REPLACE_WITH_")
  );

const navigateToWorkspace = () => {
  if (hasNavigatedToWorkspace) {
    return;
  }

  hasNavigatedToWorkspace = true;
  window.location.assign(WORKSPACE_PAGE_PATH);
};

const applyControlState = () => {
  const disabled = !state.ready || state.busy;

  googleLoginButton.disabled = disabled;
  emailInput.disabled = disabled;
  passwordInput.disabled = disabled;
  emailSubmitButton.disabled = disabled;
  switchModeButton.disabled = disabled;
  resetPasswordButton.disabled = disabled;
  signOutButton.disabled = disabled;
};

const updateModeUi = () => {
  const isSignIn = state.mode === "sign-in";

  emailSubmitButton.textContent = isSignIn
    ? "Sign in with email"
    : "Create account";
  switchModeButton.textContent = isSignIn
    ? "Sign Up"
    : "Use existing account";
  passwordInput.setAttribute(
    "autocomplete",
    isSignIn ? "current-password" : "new-password"
  );
};

const describeAuthError = (error) => {
  const code = typeof error?.code === "string" ? error.code : "unknown-error";
  const errorMessages = {
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/missing-password": "Please enter your password.",
    "auth/invalid-credential": "Invalid email or password.",
    "auth/operation-not-allowed":
      "This sign-in method is disabled. Enable Google and Email/Password in Firebase Authentication settings.",
    "auth/user-not-found": "No account exists for this email yet.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "That email already has an account.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/popup-closed-by-user": "Google sign-in was closed before completion.",
    "auth/unauthorized-domain":
      "Domain not authorized. Add localhost in Firebase Authentication settings."
  };

  const message = errorMessages[code] || error?.message || "Authentication failed.";

  return `${message} (${code})`;
};

const renderUserState = (user) => {
  const isSignedIn = Boolean(user);

  authPanel.hidden = isSignedIn;
  signedInPanel.hidden = !isSignedIn;

  if (isSignedIn) {
    userLabel.textContent = "";
    setStatus("You are signed in. Redirecting...", "success");
    window.setTimeout(navigateToWorkspace, 120);
  } else {
    userLabel.textContent = "";

    if (state.ready && !state.busy) {
      const prompt =
        state.mode === "sign-in"
          ? "Sign in to continue."
          : "Create an account with email/password, or continue with Google.";
      setStatus(prompt, "info");
    }
  }

  applyControlState();
};

const initializeFirebaseAuth = async () => {
  const [{ getApp, getApps, initializeApp }, authModule] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js")
  ]);

  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const auth = authModule.getAuth(app);
  const provider = new authModule.GoogleAuthProvider();

  provider.setCustomParameters({
    prompt: "select_account"
  });

  return { authModule, auth, provider };
};

const handleGoogleLogin = async () => {
  if (!state.ready || state.busy) {
    return;
  }

  state.busy = true;
  applyControlState();
  setStatus("Opening Google sign-in...", "info");

  try {
    await state.authModule.signInWithPopup(state.auth, state.provider);
  } catch (error) {
    if (error?.code === "auth/popup-blocked") {
      setStatus("Popup blocked. Redirecting to Google sign-in...", "info");
      await state.authModule.signInWithRedirect(state.auth, state.provider);
      return;
    }

    setStatus(describeAuthError(error), "error");
  } finally {
    state.busy = false;
    applyControlState();
  }
};

const handleEmailAuthSubmit = async (event) => {
  event.preventDefault();

  if (!state.ready || state.busy) {
    return;
  }

  if (!emailInput.reportValidity() || !passwordInput.reportValidity()) {
    return;
  }

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  state.busy = true;
  applyControlState();
  setStatus("Working on your request...", "info");

  try {
    if (state.mode === "sign-in") {
      await state.authModule.signInWithEmailAndPassword(state.auth, email, password);
      setStatus("Signed in successfully.", "success");
    } else {
      await state.authModule.createUserWithEmailAndPassword(state.auth, email, password);
      setStatus("Account created. You are now signed in.", "success");
    }

    passwordInput.value = "";
  } catch (error) {
    setStatus(describeAuthError(error), "error");
  } finally {
    state.busy = false;
    applyControlState();
  }
};

const handlePasswordReset = async () => {
  if (!state.ready || state.busy) {
    return;
  }

  const email = emailInput.value.trim();

  if (!email) {
    setStatus("Enter your email address first, then press Forgot password.", "error");
    emailInput.focus();
    return;
  }

  state.busy = true;
  applyControlState();

  try {
    await state.authModule.sendPasswordResetEmail(state.auth, email);
    setStatus("Password reset email sent. Check your inbox.", "success");
  } catch (error) {
    setStatus(describeAuthError(error), "error");
  } finally {
    state.busy = false;
    applyControlState();
  }
};

const handleModeSwitch = () => {
  if (state.busy) {
    return;
  }

  state.mode = state.mode === "sign-in" ? "sign-up" : "sign-in";
  updateModeUi();
  renderUserState(null);
};

const handleSignOut = async () => {
  if (!state.ready || state.busy) {
    return;
  }

  state.busy = true;
  applyControlState();

  try {
    await state.authModule.signOut(state.auth);
    setStatus("Signed out successfully.", "success");
  } catch (error) {
    setStatus(describeAuthError(error), "error");
  } finally {
    state.busy = false;
    applyControlState();
  }
};

const bootstrap = async () => {
  updateModeUi();
  applyControlState();

  if (!hasFirebaseConfig()) {
    setStatus(
      "Firebase config is missing. Update public/js/firebase-config.js first.",
      "error"
    );
    return;
  }

  try {
    const { authModule, auth, provider } = await initializeFirebaseAuth();

    state.authModule = authModule;
    state.auth = auth;
    state.provider = provider;
    state.ready = true;
    applyControlState();

    authModule.onAuthStateChanged(auth, (user) => {
      renderUserState(user);
    });

    const redirectResult = await authModule.getRedirectResult(auth);

    if (redirectResult?.user) {
      renderUserState(redirectResult.user);
    } else {
      renderUserState(auth.currentUser);
    }
  } catch (error) {
    console.error("Failed to initialize Firebase auth page.", error);
    setStatus(describeAuthError(error), "error");
  }
};

googleLoginButton.addEventListener("click", handleGoogleLogin);
emailAuthForm.addEventListener("submit", handleEmailAuthSubmit);
switchModeButton.addEventListener("click", handleModeSwitch);
resetPasswordButton.addEventListener("click", handlePasswordReset);
signOutButton.addEventListener("click", handleSignOut);

bootstrap();

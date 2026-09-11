/**
 * ============================================================================
 * AUTH.JS
 * Two responsibilities, kept in one small file:
 *   1. Login page logic (only runs if #loginForm exists on the page).
 *   2. Auth guard + logout, used by every protected page (dashboard,
 *      masterlist, program pages, reports, manage-users).
 * ============================================================================
 */

const LPS_SESSION_KEY = "lps_user_profile";
const LPS_POST_LOGIN_NOTICE_KEY = "lps_post_login_notice";
const LPS_GUEST_SESSION_KEY = "lps_guest_session";

/* ---------------------------------------------------------------------------
 * 1. LOGIN PAGE
 * ------------------------------------------------------------------------- */

function initLoginPage() {
  const form = document.getElementById("loginForm");
  if (!form) return;

  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const alertBox = document.getElementById("loginAlert");
  const submitBtn = document.getElementById("loginSubmit");

  async function refreshLoginStats() {
    const learnerCount = document.getElementById("loginLearnerCount");
    const programCount = document.getElementById("loginProgramCount");
    const syncStatus = document.getElementById("loginSyncStatus");
    try {
      const stats = await LPSApi.getPublicStats();
      if (learnerCount) learnerCount.textContent = Number(stats.totalLearners || 0).toLocaleString();
      if (programCount) programCount.textContent = Number(stats.programsTracked || 0).toLocaleString();
      if (syncStatus) syncStatus.textContent = stats.syncStatus || "Live";
    } catch (error) {
      if (syncStatus) syncStatus.textContent = "Unavailable";
    }
  }

  refreshLoginStats();
  window.setInterval(refreshLoginStats, 30000);

  // If already signed in, skip straight to the dashboard.
  if (isVisitorSession()) {
    window.location.href = `${APP_PAGE_PREFIX}dashboard.html`;
    return;
  }
  authPersistenceReady.then(() => {
    auth.onAuthStateChanged((user) => {
      if (user) window.location.href = `${APP_PAGE_PREFIX}dashboard.html`;
    });
  });

  function showAlert(message) {
    alertBox.textContent = message;
    alertBox.classList.add("is-visible");
  }
  function hideAlert() {
    alertBox.classList.remove("is-visible");
  }

  if (new URLSearchParams(window.location.search).get("auth") === "required") {
    showAlert("Your hosted session was not restored. Confirm this site is added to Firebase Authorized domains, then sign in again.");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showAlert("Please enter both your email and password.");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";

    try {
      await authPersistenceReady;
      const credential = await auth.signInWithEmailAndPassword(email, password);
      sessionStorage.removeItem(LPS_GUEST_SESSION_KEY);
      localStorage.removeItem(LPS_GUEST_SESSION_KEY);
      void LPSApi.recordAuditEvent("LOGIN", { ipSession: appSessionId() }).catch(() => {});
      // Cache a small display profile so pages can render a name instantly
      // without waiting on a Sheets lookup. Never store passwords here.
      sessionStorage.setItem(
        LPS_SESSION_KEY,
        JSON.stringify({ email: credential.user.email, uid: credential.user.uid })
      );
      sessionStorage.setItem(LPS_POST_LOGIN_NOTICE_KEY, "1");
      window.location.href = `${APP_PAGE_PREFIX}dashboard.html`;
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
      showAlert(friendlyAuthError(err));
    }
  });
}

function friendlyAuthError(err) {
  switch (err.code) {
    case "auth/invalid-email":
      return "That email address doesn't look right. Please check and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Please contact your school admin.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password. Please try again.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Please wait a moment before trying again.";
    case "auth/network-request-failed":
      return "Network error. Please check your internet connection.";
    default:
      return "We couldn't sign you in. Please try again, or contact your school admin.";
  }
}

/* ---------------------------------------------------------------------------
 * 2. AUTH GUARD for protected pages
 * ------------------------------------------------------------------------- */

/**
 * Call this at the top of every protected page. It resolves once we know
 * for sure whether a user is signed in, and redirects to the login page
 * if not — so page-specific scripts can safely assume `user` is real.
 */
function requireAuth() {
  return new Promise((resolve) => {
    ensureVisitorSession();
    if (isVisitorSession()) {
      const pageName = window.location.pathname.split(/[\\/]/).pop().toLowerCase();
      if (!["dashboard.html", "enrollment-data.html"].includes(pageName)) {
        window.location.replace(appPageHref("dashboard.html"));
        return;
      }
      APP_USER_PROFILE = { email: "", uid: "guest", role: "Visitor" };
      resolve({ uid: "guest", email: null, isGuest: true });
      return;
    }
    authPersistenceReady.then(() => auth.onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.replace(loginPageUrl("?auth=required"));
        return;
      }
      const cachedProfile = storedAppProfile();
      const profile = cachedProfile || { role: "Visitor" };
      APP_USER_PROFILE = profile;
      sessionStorage.setItem(
        LPS_SESSION_KEY,
        JSON.stringify({ email: user.email, uid: user.uid, role: profile.role })
      );
      if (sessionStorage.getItem(LPS_POST_LOGIN_NOTICE_KEY) === "1") {
        sessionStorage.removeItem(LPS_POST_LOGIN_NOTICE_KEY);
        window.setTimeout(() => showToast(
          "Some workspace components may take a moment to initialize. If anything remains incomplete, refresh this tab.",
          "info",
          { title: "Welcome back", actionLabel: "Refresh tab", onAction: () => window.location.reload(), duration: 12000 }
        ), 350);
      }
      try {
        const freshProfile = await LPSApi.getMyProfile();
        APP_USER_PROFILE = freshProfile;
        sessionStorage.setItem(
          LPS_SESSION_KEY,
          JSON.stringify({ email: user.email, uid: user.uid, role: freshProfile.role })
        );
      } catch (error) {
        // Keep the cached profile so the page can still render during a temporary API outage.
      }
      resolve(user);
    }));
  });
}

function initials(email) {
  if (!email) return "?";
  const name = email.split("@")[0].replace(/[._]/g, " ");
  const parts = name.trim().split(" ").filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0].toUpperCase());
  return letters.join("") || "?";
}

function displayNameFromEmail(email) {
  if (!email) return "User";
  const name = email.split("@")[0].replace(/[._]/g, " ");
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

function loginPageUrl(query = "") {
  const loginUrl = new URL(APP_LOGIN_PATH, window.location.href);
  if (window.location.hostname.endsWith(".ct.ws")) {
    loginUrl.protocol = "http:";
    loginUrl.pathname = "/";
  }
  loginUrl.search = query;
  return loginUrl.href;
}

async function handleLogout() {
  const button = document.getElementById("logoutBtn");
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="inline-spinner" aria-hidden="true"></span>';
    button.title = "Signing out…";
    button.setAttribute("aria-label", "Signing out");
    button.setAttribute("aria-busy", "true");
  }
  try {
    void LPSApi.recordAuditEvent("LOGOUT", { ipSession: appSessionId() }).catch(() => {});
    if (!isVisitorSession()) {
      await Promise.race([
        auth.signOut(),
        new Promise((resolve) => window.setTimeout(resolve, 3000)),
      ]);
    }
  } finally {
    sessionStorage.removeItem(LPS_SESSION_KEY);
    sessionStorage.removeItem(LPS_GUEST_SESSION_KEY);
    localStorage.removeItem(LPS_GUEST_SESSION_KEY);
    if (typeof LPSCache !== "undefined") LPSCache.clear();
    window.location.replace(loginPageUrl());
  }
}

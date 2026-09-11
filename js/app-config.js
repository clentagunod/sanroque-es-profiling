const APP_CONFIG = Object.freeze({
  firebase: {
    apiKey: "AIzaSyCKpafPoWfl0njw4qPaUONpvDzEifyVtM4",
    authDomain: "san-roque-es-dashboard.firebaseapp.com",
    projectId: "san-roque-es-dashboard",
    storageBucket: "san-roque-es-dashboard.firebasestorage.app",
    messagingSenderId: "54497527570",
    appId: "1:54497527570:web:7444fdcad3326c6fb995cb",
  },
  // Set this after deploying apps-script/AuditLog.gs as a Web App.
  auditLogApiUrl: "https://script.google.com/macros/s/AKfycbxV2iJv89fOqZGRWGIyHKLMc-nk9t4CyytwKtb2B4e_94qgka5Y2pUTBlCxRanTVctbFg/exec",
  feedbackApiUrl: "https://script.google.com/macros/s/AKfycby9RSvbuCuK4HKM_Nip1cmeHziQUHum-mYnkNWeG5PqL7Kwd78AZqk3p6T4JOpTeJlC/exec",
  // Paste the Google Sheets backup URL here after creating the backup sheet.
  backupSpreadsheetUrl: "https://script.google.com/macros/s/AKfycbwxarMZMTlt6nq7-Kd2ENNdPs7f99i-dF3jdFSabITiaSmNtphrYxDNOp9CrS-0FtHE/exec",
  assetsPath: "assets/",
  pagePath: "pages/",
});

const APP_IS_PAGES_ROUTE = /[\\/]pages[\\/]/i.test(window.location.pathname);
const APP_PAGE_PREFIX = APP_IS_PAGES_ROUTE ? "" : "pages/";
const APP_ASSET_PREFIX = APP_IS_PAGES_ROUTE ? "../assets/" : "assets/";
const APP_LOGIN_PATH = APP_IS_PAGES_ROUTE ? "../index.html" : "index.html";
let APP_USER_PROFILE = null;
const VISITOR_SESSION_VALUE = String(Date.now() + 30 * 60 * 1000);

function storedAppProfile() {
  try { return JSON.parse(sessionStorage.getItem("lps_user_profile") || "null"); } catch (error) { return null; }
}

function hasVisitorEntryMarker() {
  return new URLSearchParams(window.location.search).get("visitor") === "1";
}

function ensureVisitorSession() {
  if (!hasVisitorEntryMarker()) return false;
  try {
    sessionStorage.setItem("lps_guest_session", "1");
    localStorage.setItem("lps_guest_session", VISITOR_SESSION_VALUE);
    sessionStorage.setItem("lps_user_profile", JSON.stringify({ email: "", uid: "guest", role: "Visitor" }));
  } catch (error) {
    // The auth guard will show the regular login flow if browser storage is unavailable.
  }
  return true;
}

function appSessionId() {
  const key = "lps_session_id";
  try {
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(key, value);
    }
    return value;
  } catch (error) {
    return "browser-session";
  }
}

function normalizedAppRole(role) {
  const value = String(role || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value === "schooladmin" || value === "admin" || value === "schooladministrator") return "School Admin";
  if (value === "registrar") return "Registrar";
  if (value === "teacher") return "Teacher";
  if (value === "visitor") return "Visitor";
  return String(role || "").trim();
}

function appRole() { return normalizedAppRole(APP_USER_PROFILE?.role); }
function isVisitorSession() {
  if (hasVisitorEntryMarker()) {
    ensureVisitorSession();
    return true;
  }
  try {
    const localValue = Number(localStorage.getItem("lps_guest_session"));
    if (localValue && localValue < Date.now()) localStorage.removeItem("lps_guest_session");
    return sessionStorage.getItem("lps_guest_session") === "1"
      || (localValue > Date.now());
  } catch (error) {
    return false;
  }
}
function canManageLearners() { return ["School Admin", "Registrar", "Teacher"].includes(appRole()); }
function isSchoolAdmin() { return appRole() === "School Admin"; }
function canViewGradesProfile() {
  const role = appRole();
  return !role || ["School Admin", "Registrar", "Teacher"].includes(role);
}

function paginationPageNumbers(page, pageCount) {
  const windowSize = 5;
  const safePage = Math.max(1, Math.min(pageCount, Number(page) || 1));
  const groupStart = Math.min(safePage, Math.max(1, pageCount - windowSize + 1));
  const groupEnd = Math.min(pageCount, groupStart + windowSize - 1);
  const pages = [];
  for (let value = groupStart; value <= groupEnd; value += 1) pages.push(value);
  return pages;
}

function formSnapshot(form) {
  if (!form) return "";
  return JSON.stringify([...form.elements].map((field) => ({
    id: field.id || field.name || "",
    type: field.type || "",
    value: field.type === "checkbox" || field.type === "radio" ? field.checked : field.value,
  })));
}

function confirmDiscardChanges(form, initialSnapshot, itemName = "form") {
  if (formSnapshot(form) === initialSnapshot) return true;
  return window.confirm(`You have unsaved changes in this ${itemName}.\n\nDo you want to discard them and close? Your changes will not be saved.`);
}

/**
 * ============================================================================
 * FIREBASE CONFIGURATION
 * ============================================================================
 * Firebase and Apps Script public runtime values are maintained in
 * `app-config.js`. This file initializes Firebase and exposes the shared
 * `auth` and Firebase runtime values to the rest of the site.
 *
 * WHERE TO GET THESE VALUES (see SETUP_GUIDE.md, Part 1, Step 4):
 *   Firebase Console → Project settings (gear icon) → General tab →
 *   "Your apps" card → the </> (Web app) → firebaseConfig object.
 *
 * SECURITY NOTE: unlike a database password, this config is *meant* to be
 * public — it ships inside every browser that loads your site. Real access
 * control happens with Firebase Authentication (who can sign in) and, later,
 * with checks in your Google Apps Script backend (Part 2 of the guide). Do
 * NOT paste a "service account" JSON file here — that is a different,
 * secret credential and must never appear in frontend code.
 * ============================================================================
 */

// Configuration values are maintained in app-config.js.
const firebaseConfig = APP_CONFIG.firebase;

// Initialize Firebase (compat SDK — chosen so this project runs from plain
// <script> tags with no build step, which keeps setup simple for a school).
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
let userCreationAuth = null;

function getUserCreationAuth() {
	if (!userCreationAuth) {
		const app = firebase.apps.find((item) => item.name === "user-creation") || firebase.initializeApp(firebaseConfig, "user-creation");
		userCreationAuth = app.auth();
	}
	return userCreationAuth;
}
// Keep the sign-in available while moving between the separate HTML pages.
// Some browsers reject local persistence, so retain the session fallback.
const authPersistenceReady = auth
	.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
	.catch(() => auth.setPersistence(firebase.auth.Auth.Persistence.SESSION))
	.catch(() => undefined);

/**
 * Google Apps Script Web App URL.
 * You get this in SETUP_GUIDE.md, Part 2, Step 6, after you deploy the
 * Apps Script project as a Web App. It looks like:
 *   https://script.google.com/macros/s/AKfycb.../exec
 */
// Application records are stored in Firestore. Google Apps Script is used
// only by the separately deployed Feedback and AuditLog services.
const SHEETS_API_URL = "";

/**
 * Firestore (live database).
 * Same Firebase project as Auth above — no extra config needed. Firestore
 * must be created once in the Firebase Console (Build → Firestore Database
 * → Create database → Production mode) before this works. See
 * README_FIRESTORE_MIGRATION.md, Part 1.
 *
 * Enabling offline persistence lets pages that use `db` keep working (read
 * cached data) for a few seconds of flaky connectivity, and queues writes
 * until the connection returns — this is what makes the UI feel "live"
 * instead of static.
 */
const db = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true }).catch((error) => {
  // "failed-precondition" = more than one tab open; "unimplemented" = old
  // browser. Neither is fatal — Firestore just falls back to network-only.
  console.warn("Firestore offline persistence not enabled:", error.code);
});

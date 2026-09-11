/**
 * San Roque ES - standalone AuditLog service.
 *
 * This is the only remaining Google Apps Script data service for the website.
 * It must be deployed separately as a Web App. Store these Script Properties:
 *   AUDIT_SPREADSHEET_ID
 *   FIRESTORE_PROJECT_ID
 *   FIREBASE_WEB_API_KEY
 *   FIREBASE_SERVICE_ACCOUNT_JSON
 *
 * The service never receives learner profiles. It stores controlled metadata
 * and allowlisted status fields only.
 */

const AUDIT_HEADERS = ["Timestamp", "User", "Action", "Sheet", "Record/ID", "Old Value", "New Value", "IP/Session"];
const AUDIT_ACTIONS = ["LOGIN", "LOGOUT", "LEARNER_ADD", "LEARNER_UPDATE", "LEARNER_DELETE", "USER_ADD", "USER_UPDATE", "USER_DELETE", "ENROLLMENT_UPDATE", "SETTINGS_UPDATE"];
const AUDIT_STAFF_ACTIONS = ["LEARNER_ADD", "LEARNER_UPDATE", "LEARNER_DELETE", "ENROLLMENT_UPDATE"];
const AUDIT_ADMIN_ACTIONS = ["USER_ADD", "USER_UPDATE", "USER_DELETE", "SETTINGS_UPDATE"];
const AUDIT_SAFE_FIELDS = ["schoolYear", "gradeLevel", "section", "gender", "enrollmentStatus", "eosyStatus", "transferType", "transferDate", "role", "status"];

function doGet(event) {
  try {
    const params = event.parameter || {};
    const auth = authorizeAudit_(params.token);
    if (auth.role !== "School Admin") throw new Error("Only a School Admin can view administrator data.");
    if (params.action === "getAuditLogs") return jsonAudit_({ ok: true, data: readAuditLogs_() });
    if (params.action === "getFirestoreUsage") return jsonAudit_({ ok: true, data: readFirestoreUsage_() });
    throw new Error("Unknown audit action.");
  } catch (error) {
    return jsonAudit_({ ok: false, error: error.message || "Audit request failed." });
  }
}

function doPost(event) {
  try {
    const body = JSON.parse(event.postData.contents || "{}");
    const auth = authorizeAudit_(body.token);
    if (body.action === "deleteAuthUsers") return deleteAuthUsersResponse_(auth, body.userIds);
    if (body.action !== "recordAuditEvent") throw new Error("Unknown audit action.");
    const action = String(body.auditAction || "").trim().toUpperCase();
    if (!AUDIT_ACTIONS.includes(action)) throw new Error("That audit event is not allowed.");
    if (AUDIT_ADMIN_ACTIONS.includes(action) && auth.role !== "School Admin") throw new Error("Only a School Admin can record this event.");
    if (AUDIT_STAFF_ACTIONS.includes(action) && !["School Admin", "Registrar", "Teacher"].includes(auth.role)) throw new Error("You are not allowed to record this event.");
    appendAuditLog_(auth.email, action, body);
    return jsonAudit_({ ok: true, data: { recorded: true } });
  } catch (error) {
    return jsonAudit_({ ok: false, error: error.message || "Audit event failed." });
  }
}

function deleteAuthUsersResponse_(auth, userIds) {
  if (auth.role !== "School Admin") throw new Error("Only a School Admin can delete Firebase accounts.");
  const ids = Array.isArray(userIds) ? userIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (!ids.length || ids.length > 100) throw new Error("Provide between 1 and 100 Firebase user IDs.");
  if (ids.includes(auth.uid)) throw new Error("You cannot delete the account you are currently using.");
  ids.forEach(deleteFirebaseAuthUser_);
  return jsonAudit_({ ok: true, data: { deleted: ids.length } });
}

function deleteFirebaseAuthUser_(uid) {
  const response = UrlFetchApp.fetch(`https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(auditProperty_("FIRESTORE_PROJECT_ID"))}/accounts:delete`, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${firebaseAdminAccessToken_()}` },
    payload: JSON.stringify({ localId: uid }),
    muteHttpExceptions: true,
  });
  const result = JSON.parse(response.getContentText() || "{}");
  if (response.getResponseCode() !== 200) {
    const message = result.error && result.error.message ? result.error.message : "Firebase Authentication rejected the deletion.";
    throw new Error(`Could not delete Firebase account ${uid}: ${message}`);
  }
}

function firebaseAdminAccessToken_() {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(auditProperty_("FIREBASE_SERVICE_ACCOUNT_JSON"));
  } catch (error) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  const header = base64Url_(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = base64Url_(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: arguments.length ? arguments[0] : "https://www.googleapis.com/auth/identitytoolkit",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, serviceAccount.private_key)).replace(/=+$/, "");
  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` },
    muteHttpExceptions: true,
  });
  const result = JSON.parse(response.getContentText() || "{}");
  if (response.getResponseCode() !== 200 || !result.access_token) throw new Error("Could not obtain a Firebase Admin access token.");
  return result.access_token;
}

function readFirestoreUsage_() {
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
  const metrics = {
    reads: "firestore.googleapis.com/document/read_ops_count",
    writes: "firestore.googleapis.com/document/write_ops_count",
    deletes: "firestore.googleapis.com/document/delete_ops_count",
  };
  const usage = {};
  Object.entries(metrics).forEach(([key, metric]) => { usage[key] = readMetricSeries_(metric, start, end); });
  return {
    plan: "Spark free tier",
    limits: { reads: 50000, writes: 20000, deletes: 20000 },
    days: mergeUsageDays_(usage),
    refreshedAt: new Date().toISOString(),
    nextResetAt: nextPacificMidnight_().toISOString(),
  };
}

function readMetricSeries_(metricType, start, end) {
  const projectId = encodeURIComponent(auditProperty_("FIRESTORE_PROJECT_ID"));
  const params = [
    `filter=${encodeURIComponent(`metric.type="${metricType}"`)}`,
    `interval.startTime=${encodeURIComponent(start.toISOString())}`,
    `interval.endTime=${encodeURIComponent(end.toISOString())}`,
    "aggregation.alignmentPeriod=86400s",
    "aggregation.perSeriesAligner=ALIGN_SUM",
    "aggregation.crossSeriesReducer=REDUCE_SUM",
    "pageSize=1000",
  ].join("&");
  const response = UrlFetchApp.fetch(`https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`, {
    headers: { Authorization: `Bearer ${firebaseAdminAccessToken_("https://www.googleapis.com/auth/cloud-platform")}` },
    muteHttpExceptions: true,
  });
  const result = JSON.parse(response.getContentText() || "{}");
  if (response.getResponseCode() !== 200) {
    const message = result.error && result.error.message ? result.error.message : "Cloud Monitoring rejected the usage request.";
    throw new Error(message);
  }
  const totals = {};
  (result.timeSeries || []).forEach((series) => (series.points || []).forEach((point) => {
    const date = String(point.interval?.endTime || "").slice(0, 10);
    if (date) totals[date] = (totals[date] || 0) + Number(point.value?.int64Value || point.value?.doubleValue || 0);
  }));
  return totals;
}

function mergeUsageDays_(usage) {
  const dates = new Set([...Object.values(usage).flatMap((values) => Object.keys(values))]);
  return [...dates].sort().map((date) => ({ date, reads: usage.reads[date] || 0, writes: usage.writes[date] || 0, deletes: usage.deletes[date] || 0 }));
}

function nextPacificMidnight_() {
  const now = new Date();
  const pacificDate = Utilities.formatDate(now, "America/Los_Angeles", "yyyy-MM-dd");
  const tomorrow = new Date(`${pacificDate}T00:00:00-08:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

function base64Url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/, "");
}

function jsonAudit_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function auditProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`Missing ${name} Script Property.`);
  if (name === "FIREBASE_WEB_API_KEY" && /PRIVATE KEY|BEGIN|END/.test(value)) {
    throw new Error("FIREBASE_WEB_API_KEY is misconfigured. Use the Firebase Web app apiKey (starts with AIza), not the service-account private key.");
  }
  return value;
}

function authorizeAudit_(idToken) {
  if (!idToken || String(idToken).length > 5000) throw new Error("Missing or invalid Firebase token.");
  const webApiKey = auditProperty_("FIREBASE_WEB_API_KEY").trim();
  if (!/^AIza[\w-]+$/.test(webApiKey)) throw new Error("FIREBASE_WEB_API_KEY must be the Firebase Web app apiKey, not a private key or service-account credential.");
  const response = UrlFetchApp.fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(webApiKey)}`, {
    method: "post", contentType: "application/json", payload: JSON.stringify({ idToken }), muteHttpExceptions: true,
  });
  const result = JSON.parse(response.getContentText() || "{}");
  const user = result.users && result.users[0];
  if (response.getResponseCode() !== 200 || !user || !user.localId) throw new Error("Firebase authentication failed.");
  const profileUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(auditProperty_("FIRESTORE_PROJECT_ID"))}/databases/(default)/documents/users/${encodeURIComponent(user.localId)}`;
  const profileResponse = UrlFetchApp.fetch(profileUrl, { headers: { Authorization: `Bearer ${idToken}` }, muteHttpExceptions: true });
  const profile = JSON.parse(profileResponse.getContentText() || "{}");
  if (profileResponse.getResponseCode() !== 200 || !profile.fields) throw new Error("No authorized Firestore profile found.");
  const role = firestoreString_(profile.fields.role);
  const status = firestoreString_(profile.fields.status);
  if (status !== "Active") throw new Error("Your account is not active.");
  return { uid: user.localId, email: user.email || "", role };
}

function firestoreString_(field) {
  if (!field) return "";
  return field.stringValue || String(field.integerValue || field.booleanValue || "");
}

function auditText_(value, maxLength) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function auditId_(value) {
  return auditText_(value, 120).replace(/[^a-zA-Z0-9._:@,\- ]/g, "");
}

function auditValue_(value) {
  if (value == null || value === "") return "";
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch (error) { return auditText_(value, 300); }
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) return auditText_(parsed, 300);
  const safe = {};
  AUDIT_SAFE_FIELDS.forEach((field) => { if (Object.prototype.hasOwnProperty.call(parsed, field)) safe[field] = auditText_(parsed[field], 100); });
  return JSON.stringify(safe).slice(0, 800);
}

function auditSheet_(value) {
  const label = auditText_(value, 100);
  return /^(learners|dropout|transferredOut|users|sections|schoolYears|settings|enrollment|audit)([_a-zA-Z0-9-]*)$/i.test(label) ? label : "application";
}

function auditSpreadsheet_() {
  return SpreadsheetApp.openById(auditProperty_("AUDIT_SPREADSHEET_ID"));
}

function auditSheetObject_() {
  const spreadsheet = auditSpreadsheet_();
  let sheet = spreadsheet.getSheetByName("AuditLog");
  if (!sheet) sheet = spreadsheet.insertSheet("AuditLog");
  const headers = sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).getValues()[0].map(String);
  if (!AUDIT_HEADERS.every((header, index) => headers[index].trim() === header)) {
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setFontWeight("bold");
  }
  return sheet;
}

function appendAuditLog_(email, action, event) {
  const sheet = auditSheetObject_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Audit service is busy. Please try again.");
  try {
    sheet.appendRow([new Date(), auditText_(email, 160), action, auditSheet_(event.sheet), auditId_(event.recordId), auditValue_(event.oldValue), auditValue_(event.newValue), auditId_(event.ipSession)]);
  } finally {
    lock.releaseLock();
  }
}

function readAuditLogs_() {
  const sheet = auditSheetObject_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, AUDIT_HEADERS.length).getDisplayValues();
  return rows.map((row) => ({ timestamp: row[0], user: row[1], action: row[2], sheet: row[3], recordId: row[4], oldValue: auditValue_(row[5]), newValue: auditValue_(row[6]), ipSession: auditId_(row[7]) })).reverse().slice(0, 500);
}

function redactExistingAuditLog() {
  const sheet = auditSheetObject_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return "AuditLog has no entries to redact.";
  [6, 7].forEach((column) => {
    const range = sheet.getRange(2, column, lastRow - 1, 1);
    range.setValues(range.getValues().map((row) => [auditValue_(row[0])]));
  });
  return "Existing AuditLog values were redacted.";
}

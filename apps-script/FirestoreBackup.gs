/**
 * ============================================================================
 * FIRESTORE BACKUP EXPORTER
 * ============================================================================
 * Exports the complete Firestore database into a human-readable Google Sheet.
 * Run setupBackupTrigger() once to install the daily backup.
 *
 * Script Properties required:
 *   FIRESTORE_PROJECT_ID
 *   FIRESTORE_CLIENT_EMAIL
 *   FIRESTORE_PRIVATE_KEY
 *   BACKUP_SPREADSHEET_ID (optional; created automatically when omitted)
 *
 * The private key is read only from Script Properties. Never commit it to the
 * repository or place it in frontend files.
 * ============================================================================
 */

const BACKUP_COLLECTIONS = [
  { collection: "users", sheetName: "Backup_Users" },
  { collection: "schoolYears", sheetName: "Backup_SchoolYears" },
  { collection: "sections", sheetName: "Backup_Sections" },
  { collection: "settings", sheetName: "Backup_Settings" },
  { collection: "publicStats", sheetName: "Backup_PublicStats" },
];

const BACKUP_LEARNER_FIELDS = [
  "learnerId", "firstName", "lastName", "middleName", "age", "birthDate", "name", "gradeLevel", "section", "gender",
  "guardian", "contact", "enrollmentStatus", "eosyStatus", "schoolYear", "dateAdded", "is4Ps", "isIP", "isSNED", "isARAL", "isMuslim",
  "bosyHeight", "bosyWeight", "bosyNutritionalStatus", "mosyHeight", "mosyWeight", "mosyNutritionalStatus", "eosyHeight", "eosyWeight", "eosyNutritionalStatus",
  "bosyCRLA", "mosyCRLA", "eosyCRLA", "bosyPhilIRI", "mosyPhilIRI", "eosyPhilIRI", "bosyRMA", "mosyRMA", "eosyRMA",
  "filipino", "english", "math", "science", "aralPan", "esp", "music", "arts", "pe", "health", "epp", "motherTongue",
  "transferType", "transferIn", "transferOut", "transferSchool", "transferDate", "transferReason", "transferNotes", "extra",
];

/** Opens the sheet, or runs a protected on-demand backup from Admin Console. */
function doGet(event) {
  try {
    const params = event && event.parameter ? event.parameter : {};
    if (params.action === "runBackup") {
      authorizeBackupAdmin_(params.token);
      return backupJson_({ ok: true, data: { message: exportFirestoreBackupToSheets(), url: getBackupSpreadsheetUrl() } });
    }
    const url = getBackupSpreadsheetUrl();
    const safeUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return HtmlService.createHtmlOutput(`<meta http-equiv="refresh" content="0;url=${safeUrl}"><p>Opening the Firestore backup spreadsheet…</p><p><a href="${safeUrl}">Open backup spreadsheet</a></p>`);
  } catch (error) {
    return backupJson_({ ok: false, error: error.message || "Backup failed." });
  }
}

function backupJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function authorizeBackupAdmin_(idToken) {
  if (!idToken || String(idToken).length > 5000) throw new Error("Missing Firebase sign-in token.");
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("FIREBASE_WEB_API_KEY");
  const projectId = props.getProperty("FIRESTORE_PROJECT_ID");
  if (!apiKey || !projectId) throw new Error("Add FIREBASE_WEB_API_KEY and FIRESTORE_PROJECT_ID Script Properties.");
  const authResponse = UrlFetchApp.fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: "post", contentType: "application/json", payload: JSON.stringify({ idToken }), muteHttpExceptions: true,
  });
  const authBody = JSON.parse(authResponse.getContentText() || "{}");
  const user = authBody.users && authBody.users[0];
  if (authResponse.getResponseCode() !== 200 || !user || !user.localId) throw new Error("Firebase authentication failed.");
  const profileResponse = UrlFetchApp.fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/users/${encodeURIComponent(user.localId)}`, {
    headers: { Authorization: `Bearer ${idToken}` }, muteHttpExceptions: true,
  });
  const profile = JSON.parse(profileResponse.getContentText() || "{}");
  const role = profile.fields?.role?.stringValue || "";
  const status = profile.fields?.status?.stringValue || "";
  if (profileResponse.getResponseCode() !== 200 || role !== "School Admin" || status !== "Active") throw new Error("Only an active School Admin can run a Firestore backup.");
}

function setupBackupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === "exportFirestoreBackupToSheets")
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger("exportFirestoreBackupToSheets")
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  return "Nightly Firestore backup trigger installed (runs around 2 AM).";
}

/** Run this first when backup setup or permissions are uncertain. */
function verifyFirestoreBackupSetup() {
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty("FIRESTORE_PROJECT_ID");
  const clientEmail = props.getProperty("FIRESTORE_CLIENT_EMAIL");
  if (!projectId) throw new Error("Missing FIRESTORE_PROJECT_ID Script Property.");
  if (!clientEmail) throw new Error("Missing FIRESTORE_CLIENT_EMAIL Script Property.");
  try {
    getFirestoreAccessToken_();
    const result = firestoreListDocuments_("schoolYears");
    return `Firestore backup access is working for ${clientEmail}. Found ${result.length} school year document(s) in ${projectId}.`;
  } catch (error) {
    throw new Error(`${error.message} Confirm that this exact service account has Cloud Datastore Viewer in Google Cloud IAM.`);
  }
}

/** Creates or reuses the destination spreadsheet and returns its URL. */
function getBackupSpreadsheetUrl() {
  return getFirestoreBackupSpreadsheet_().getUrl();
}

function exportFirestoreBackupToSheets() {
  const spreadsheet = getFirestoreBackupSpreadsheet_();
  const startedAt = new Date();
  let learnerCount = 0;
  let archiveCount = 0;
  BACKUP_COLLECTIONS.forEach(({ collection, sheetName }) => writeBackupSheet_(spreadsheet, sheetName, firestoreListDocuments_(collection)));

  const schoolYears = firestoreListDocuments_("schoolYears").map((doc) => doc.id).filter(Boolean).sort();
  schoolYears.forEach((schoolYear) => {
    const suffix = sanitizeCollectionSuffix_(schoolYear);
    const learners = firestoreListDocuments_(`Learners/${schoolYear}/records`);
    const dropouts = firestoreListDocuments_(`Dropouts/${schoolYear}/records`);
    const transferredOut = firestoreListDocuments_(`TransferredOut/${schoolYear}/records`);
    writeBackupSheet_(spreadsheet, `Backup_Learners_${suffix}`, learners, BACKUP_LEARNER_FIELDS);
    writeBackupSheet_(spreadsheet, `Backup_Dropouts_${suffix}`, dropouts, BACKUP_LEARNER_FIELDS);
    writeBackupSheet_(spreadsheet, `Backup_TransferredOut_${suffix}`, transferredOut, BACKUP_LEARNER_FIELDS);
    learnerCount += learners.length;
    archiveCount += dropouts.length + transferredOut.length;
  });

  const currentYear = currentSchoolYearId_();
  if (!schoolYears.length && currentYear) {
    const suffix = sanitizeCollectionSuffix_(currentYear);
    const learners = firestoreListDocuments_(`Learners/${currentYear}/records`);
    writeBackupSheet_(spreadsheet, `Backup_Learners_${suffix}`, learners, BACKUP_LEARNER_FIELDS);
    writeBackupSheet_(spreadsheet, `Backup_Dropouts_${suffix}`, firestoreListDocuments_(`Dropouts/${currentYear}/records`), BACKUP_LEARNER_FIELDS);
    writeBackupSheet_(spreadsheet, `Backup_TransferredOut_${suffix}`, firestoreListDocuments_(`TransferredOut/${currentYear}/records`), BACKUP_LEARNER_FIELDS);
    learnerCount = learners.length;
  }

  const logSheet = spreadsheet.getSheetByName("Backup_Log") || spreadsheet.insertSheet("Backup_Log");
  if (logSheet.getLastRow() === 0) logSheet.appendRow(["Run started", "Duration (s)", "Learners backed up", "Archived records backed up", "School years"]);
  logSheet.appendRow([startedAt, (new Date() - startedAt) / 1000, learnerCount, archiveCount, schoolYears.length || (currentYear ? 1 : 0)]);
  return `Backup complete. ${learnerCount} learner records and ${archiveCount} archived records backed up across ${schoolYears.length || (currentYear ? 1 : 0)} school year(s). Open the backup sheet: ${spreadsheet.getUrl()}`;
}

function getFirestoreBackupSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty("BACKUP_SPREADSHEET_ID");
  if (spreadsheetId) {
    try { return SpreadsheetApp.openById(spreadsheetId); }
    catch (error) { throw new Error(`Cannot open backup spreadsheet ${spreadsheetId}. Share it with the Apps Script execution account and verify the ID.`); }
  }
  const created = SpreadsheetApp.create(`San Roque ES Firestore Backup - ${properties.getProperty("FIRESTORE_PROJECT_ID") || "project"}`);
  properties.setProperty("BACKUP_SPREADSHEET_ID", created.getId());
  return created;
}

function sanitizeCollectionSuffix_(schoolYear) {
  return String(schoolYear || "").replace(/[^0-9A-Za-z]/g, "_");
}

function currentSchoolYearId_() {
  try {
    const docs = firestoreListDocuments_("settings");
    const match = docs.find((doc) => doc.id === "currentSchoolYear");
    return match ? String(match.fields.value || "") : "";
  } catch (error) {
    return "";
  }
}

function writeBackupSheet_(spreadsheet, sheetName, docs, preferredFields = []) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  sheet.clearContents();
  if (!docs.length) {
    sheet.getRange(1, 1).setValue("(no documents)");
    return;
  }
  const dynamicFields = Array.from(docs.reduce((set, doc) => {
    Object.keys(doc.fields || {}).forEach((key) => set.add(key));
    return set;
  }, new Set()));
  const fieldNames = ["id", ...preferredFields.filter((field) => dynamicFields.includes(field)), ...dynamicFields.filter((field) => !preferredFields.includes(field))];
  const rows = docs.map((doc) => fieldNames.map((name) => name === "id" ? doc.id : doc.fields[name] ?? ""));
  sheet.getRange(1, 1, 1, fieldNames.length).setValues([fieldNames.map(backupHeader_)]);
  sheet.getRange(2, 1, rows.length, fieldNames.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, fieldNames.length).setFontWeight("bold");
  sheet.autoResizeColumns(1, fieldNames.length);
}

function backupHeader_(field) {
  const labels = { learnerId: "LRN", firstName: "First Name", lastName: "Last Name", middleName: "Middle Name" };
  return labels[field] || String(field).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getFirestoreAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("firestore_access_token_cloud_platform");
  if (cached) return cached;
  const props = PropertiesService.getScriptProperties();
  const clientEmail = props.getProperty("FIRESTORE_CLIENT_EMAIL");
  const privateKey = (props.getProperty("FIRESTORE_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("Missing FIRESTORE_CLIENT_EMAIL / FIRESTORE_PRIVATE_KEY Script Properties.");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64UrlEncode_(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64UrlEncode_(JSON.stringify({ iss: clientEmail, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now }))}`;
  const jwt = `${unsigned}.${base64UrlEncodeBytes_(Utilities.computeRsaSha256Signature(unsigned, privateKey))}`;
  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", { method: "post", payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }, muteHttpExceptions: true });
  const result = JSON.parse(response.getContentText() || "{}");
  if (!result.access_token) throw new Error(`Could not authenticate with Firestore: ${response.getContentText()}`);
  cache.put("firestore_access_token_cloud_platform", result.access_token, Math.min(Number(result.expires_in || 3600) - 60, 3500));
  return result.access_token;
}

function base64UrlEncode_(value) { return base64UrlEncodeBytes_(Utilities.newBlob(value).getBytes()); }
function base64UrlEncodeBytes_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ""); }

function firestoreListDocuments_(collectionPath) {
  const projectId = PropertiesService.getScriptProperties().getProperty("FIRESTORE_PROJECT_ID");
  if (!projectId) throw new Error("Missing FIRESTORE_PROJECT_ID Script Property.");
  const documents = [];
  let pageToken = "";
  do {
    const query = [`pageSize=1000`, pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : ""].filter(Boolean).join("&");
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collectionPath}?${query}`;
    const response = UrlFetchApp.fetch(url, { headers: { Authorization: `Bearer ${getFirestoreAccessToken_()}` }, muteHttpExceptions: true });
    const body = JSON.parse(response.getContentText() || "{}");
    if (response.getResponseCode() !== 200) {
      if (response.getResponseCode() === 404 || body.error?.status === "NOT_FOUND") return [];
      if (response.getResponseCode() === 403 || body.error?.status === "PERMISSION_DENIED") {
        const serviceAccount = PropertiesService.getScriptProperties().getProperty("FIRESTORE_CLIENT_EMAIL") || "the configured service account";
        throw new Error(`Firestore denied the backup read. Grant Cloud Datastore Viewer to ${serviceAccount} in Google Cloud IAM for ${projectId}. Firestore Security Rules do not control service-account REST access.`);
      }
      throw new Error(`Firestore read failed: ${response.getContentText()}`);
    }
    (body.documents || []).forEach((doc) => documents.push({ id: doc.name.split("/").pop(), fields: decodeFirestoreFields_(doc.fields || {}) }));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function decodeFirestoreFields_(fields) {
  const output = {};
  Object.keys(fields).forEach((key) => { output[key] = decodeFirestoreValue_(fields[key]); });
  return output;
}

function decodeFirestoreValue_(value) {
  if (value == null) return "";
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return "";
  if ("mapValue" in value) return JSON.stringify(decodeFirestoreFields_(value.mapValue.fields || {}));
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeFirestoreValue_).join(", ");
  return "";
}

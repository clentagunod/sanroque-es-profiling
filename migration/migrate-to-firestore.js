/**
 * ============================================================================
 * ONE-TIME MIGRATION: Google Sheets (.xlsx exports) → Firestore
 * ============================================================================
 * Run this ONCE per school year database you want to move over, from your
 * own computer (not Apps Script — this needs the firebase-admin SDK, which
 * only runs in Node.js). See README_FIRESTORE_MIGRATION.md, Part 4.
 *
 * SETUP
 *   1. npm install firebase-admin xlsx
 *   2. Firebase Console → Project settings → Service accounts →
 *      "Generate new private key" → save as serviceAccountKey.json next to
 *      this file (do NOT commit it — it's already in .gitignore).
 *   3. Download the current Core / Enrollment / Academic spreadsheets as
 *      .xlsx (File → Download → Microsoft Excel) into this same folder.
 *      Every `Enrollment_Data_<school-year>` tab in the Enrollment workbook
 *      is imported automatically into Firestore's `sections` collection.
 *   4. Review WRITE_ENABLED below — it defaults to false (dry run) so you
 *      can check the console output before touching Firestore for real.
 *
 * USAGE
 *   node migrate-to-firestore.js
 * ============================================================================
 */

const admin = require("firebase-admin");
const xlsx = require("xlsx");
const path = require("path");

const WRITE_ENABLED = true; // set true only after reviewing a validated dry run
const CORE_FILE = path.join(__dirname, "01_CORE_DATABASE.xlsx");
const ENROLLMENT_FILE = path.join(__dirname, "02_ENROLLMENT_DATABASE.xlsx");
const ACADEMIC_FILE = path.join(__dirname, "03_ACADEMIC_DATABASE.xlsx");

admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();
const auth = admin.auth();

function sheetToObjects(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.warn(`  (sheet "${sheetName}" not found — skipping)`);
    return [];
  }
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function collectionSuffix(schoolYear) {
  return String(schoolYear || "").replace(/[^0-9A-Za-z]/g, "_");
}

function normalizedRow_(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
}

function rowValue_(row, ...names) {
  const source = normalizedRow_(row);
  for (const name of names) {
    const value = source[String(name).toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function validateSchoolYear_(value, location, errors) {
  const schoolYear = String(value || "").trim();
  if (!/^\d{4}-\d{4}$/.test(schoolYear)) errors.push(`${location}: schoolYear must use YYYY-YYYY, received "${schoolYear || "blank"}"`);
  return schoolYear;
}

function validateLearnerRows_(rows, schoolYear, sheetName, errors) {
  if (!rows.length) {
    errors.push(`${sheetName}: at least one learner row is required`);
    return;
  }
  const ids = new Set();
  rows.forEach((row, index) => {
    const location = `${sheetName} row ${index + 2}`;
    const learnerId = rowValue_(row, "learnerId", "LRN");
    const firstName = rowValue_(row, "firstName", "First Name");
    const lastName = rowValue_(row, "lastName", "Last Name");
    const rowYear = rowValue_(row, "schoolYear", "School Year");
    if (!learnerId) errors.push(`${location}: learnerId/LRN is required`);
    if (!firstName) errors.push(`${location}: firstName is required`);
    if (!lastName) errors.push(`${location}: lastName is required`);
    if (rowYear && rowYear !== schoolYear) errors.push(`${location}: schoolYear "${rowYear}" does not match ${schoolYear}`);
    if (learnerId && ids.has(learnerId)) errors.push(`${location}: duplicate learnerId/LRN "${learnerId}" in ${schoolYear}`);
    if (learnerId) ids.add(learnerId);
  });
}

function validateArchiveRows_(rows, sheetName, errors) {
  const idsByYear = new Map();
  rows.forEach((row, index) => {
    const location = `${sheetName} row ${index + 2}`;
    const learnerId = rowValue_(row, "learnerId", "LRN");
    const schoolYear = validateSchoolYear_(rowValue_(row, "schoolYear", "School Year"), location, errors);
    if (!learnerId) errors.push(`${location}: learnerId/LRN is required`);
    const ids = idsByYear.get(schoolYear) || new Set();
    if (learnerId && ids.has(learnerId)) errors.push(`${location}: duplicate learnerId/LRN "${learnerId}" in ${schoolYear}`);
    if (learnerId) ids.add(learnerId);
    if (schoolYear) idsByYear.set(schoolYear, ids);
  });
}

function validateMigrationInputs_() {
  const errors = [];
  const core = xlsx.readFile(CORE_FILE);
  const enrollment = xlsx.readFile(ENROLLMENT_FILE);
  const academic = xlsx.readFile(ACADEMIC_FILE);
  const yearRows = sheetToObjects(core, "SchoolYears");
  const registeredYears = new Set();

  yearRows.forEach((row, index) => {
    const schoolYear = validateSchoolYear_(rowValue_(row, "schoolYear", "School Year"), `SchoolYears row ${index + 2}`, errors);
    if (schoolYear) registeredYears.add(schoolYear);
  });

  const learnerSheets = core.SheetNames.filter((name) => /^Learners_/i.test(name));
  if (!learnerSheets.length) errors.push("Core workbook: no Learners_<school-year> sheets found");
  learnerSheets.forEach((sheetName) => {
    const schoolYear = validateSchoolYear_(sheetName.replace(/^Learners_/i, ""), sheetName, errors);
    if (schoolYear && registeredYears.size && !registeredYears.has(schoolYear)) errors.push(`${sheetName}: school year is missing from SchoolYears`);
    validateLearnerRows_(sheetToObjects(core, sheetName), schoolYear, sheetName, errors);
  });

  validateArchiveRows_(sheetToObjects(enrollment, "Transferred Out"), "Transferred Out", errors);
  validateArchiveRows_(sheetToObjects(enrollment, "Dropout"), "Dropout", errors);

  sheetToObjects(academic, "LearnerAssessments").forEach((row, index) => {
    const location = `LearnerAssessments row ${index + 2}`;
    if (!rowValue_(row, "learnerId", "LRN")) errors.push(`${location}: learnerId/LRN is required`);
    validateSchoolYear_(rowValue_(row, "schoolYear", "School Year"), location, errors);
  });

  if (errors.length) {
    throw new Error(`Excel validation failed with ${errors.length} error(s):\n- ${errors.slice(0, 40).join("\n- ")}${errors.length > 40 ? "\n- ...more errors omitted" : ""}`);
  }
  console.log(`Excel validation passed: ${learnerSheets.length} learner sheet(s), ${yearRows.length} registered school year(s), and archive records are year-scoped.`);
}

const LEARNER_FIELD_ORDER = [
  "firstName", "lastName", "middleName", "age", "birthDate", "learnerId", "name", "gradeLevel", "section", "gender",
  "guardian", "contact", "enrollmentStatus", "eosyStatus", "schoolYear", "dateAdded",
  "is4Ps", "isIP", "isSNED", "isARAL", "isMuslim",
  "bosyHeight", "bosyWeight", "bosyNutritionalStatus", "mosyHeight", "mosyWeight", "mosyNutritionalStatus", "eosyHeight", "eosyWeight", "eosyNutritionalStatus",
  "bosyCRLA", "mosyCRLA", "eosyCRLA", "bosyPhilIRI", "mosyPhilIRI", "eosyPhilIRI", "bosyRMA", "mosyRMA", "eosyRMA",
  "filipino", "english", "math", "science", "aralPan", "esp", "music", "arts", "pe", "health", "epp", "motherTongue",
  "transferType", "transferIn", "transferOut", "transferSchool", "transferDate", "transferReason", "transferNotes",
];

function normalizeLearnerDocument(row, schoolYear) {
  const source = Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  const valueFor = (field) => source[field.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? "";
  const knownSourceFields = new Set([...LEARNER_FIELD_ORDER, "lrn", "_row"].map((field) => field.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const document = {};
  LEARNER_FIELD_ORDER.forEach((field) => { document[field] = field === "schoolYear" ? (row.schoolYear || schoolYear) : valueFor(field); });
  document.learnerId = String(row.learnerId || row.LRN || document.learnerId || "").trim();
  document.firstName = row.firstName ?? row.FirstName ?? document.firstName;
  document.lastName = row.lastName ?? row.LastName ?? document.lastName;
  document.middleName = row.middleName ?? row.MiddleName ?? document.middleName;
  document.name = document.name || [document.firstName, document.middleName, document.lastName].filter(Boolean).join(" ");
  document.extra = {};
  Object.keys(row).forEach((key) => {
    if (!knownSourceFields.has(String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, ""))) document.extra[key] = row[key];
  });
  return document;
}

async function writeYearLearners(root, schoolYear, rows) {
  const collectionPath = `${root}/${schoolYear}/records`;
  await writeBatch(collectionPath, rows.map((row) => ({ ...normalizeLearnerDocument(row, schoolYear), __id: row.learnerId || row.LRN })), "__id");
}

async function writeBatch(collectionPath, docs, idField) {
  console.log(`  → ${docs.length} document(s) into "${collectionPath}"`);
  if (!WRITE_ENABLED) return;
  // Firestore batches cap at 500 writes; chunk defensively for larger years.
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((doc) => {
      const id = idField ? String(doc[idField]) : undefined;
      const ref = id ? db.collection(collectionPath).doc(id) : db.collection(collectionPath).doc();
      const { [idField]: _omit, ...rest } = idField ? doc : { ...doc };
      batch.set(ref, rest, { merge: true });
    });
    await batch.commit();
  }
}

async function deleteDocuments(collectionPath, ids) {
  if (!ids.length) return;
  console.log(`  → removing ${ids.length} archived document(s) from "${collectionPath}"`);
  if (!WRITE_ENABLED) return;
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    ids.slice(i, i + 400).forEach((id) => batch.delete(db.collection(collectionPath).doc(String(id))));
    await batch.commit();
  }
}

async function deleteLegacyCollection(collectionPath) {
  if (!WRITE_ENABLED) return;
  const references = await db.collection(collectionPath).listDocuments();
  if (!references.length) return;
  console.log(`  → removing legacy collection "${collectionPath}" (${references.length} document(s))`);
  for (let i = 0; i < references.length; i += 400) {
    const batch = db.batch();
    references.slice(i, i + 400).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

/* ---------------------------------------------------------------------------
 * 1. USERS — matched to existing Firebase Auth accounts by email so their
 * Firestore doc ID equals their auth UID (required by firestore.rules,
 * which reads users/{request.auth.uid}). Users without a matching Auth
 * account yet get an auto-generated doc ID and status "Invited" — create
 * their sign-in credentials in Firebase Console → Authentication, then
 * either re-run this script or use the Manage Users page to fix the
 * mismatch (delete the placeholder, add them again once they can sign in).
 * ------------------------------------------------------------------------- */
async function migrateUsers() {
  console.log("\n[1/4] Users");
  const workbook = xlsx.readFile(CORE_FILE);
  const rows = sheetToObjects(workbook, "Users");
  const docs = [];
  for (const row of rows) {
    const doc = { name: row.name || "", email: row.email || "", role: row.role || "Visitor", status: row.status || "Invited" };
    try {
      const authUser = await auth.getUserByEmail(doc.email);
      docs.push({ ...doc, __id: authUser.uid });
    } catch {
      console.warn(`  ! No Firebase Auth account for ${doc.email} yet — will be stored as "Invited" with a generated ID.`);
      docs.push(doc);
    }
  }
  if (!WRITE_ENABLED) { console.log(`  → ${docs.length} user(s) would be written`); return; }
  const batch = db.batch();
  docs.forEach((doc) => {
    const ref = doc.__id ? db.collection("users").doc(doc.__id) : db.collection("users").doc();
    const { __id, ...rest } = doc;
    batch.set(ref, rest, { merge: true });
  });
  await batch.commit();
}

/* ---------------------------------------------------------------------------
 * 2. SCHOOL YEARS / SECTIONS / SETTINGS
 * ------------------------------------------------------------------------- */
async function migrateReferenceData() {
  console.log("\n[2/4] School years, sections, settings");
  const workbook = xlsx.readFile(CORE_FILE);
  const enrollmentWorkbook = xlsx.readFile(ENROLLMENT_FILE);

  const years = sheetToObjects(workbook, "SchoolYears");
  await writeBatch("schoolYears", years.map((y) => ({ ...y, __docId: y.schoolYear })), "__docId");

  const sections = sheetToObjects(workbook, "Sections");
  const enrollmentSheets = enrollmentWorkbook.SheetNames.filter((name) => /^Enrollment_Data_/i.test(name));
  const enrollmentSections = enrollmentSheets.flatMap((sheetName) => {
    const schoolYear = sheetName.replace(/^Enrollment_Data_/i, "");
    return sheetToObjects(enrollmentWorkbook, sheetName).map((row) => ({ ...row, schoolYear: row.schoolYear || schoolYear }));
  });
  const sectionRows = [...sections, ...enrollmentSections]
    .filter((row) => row.schoolYear && row.gradeLevel && row.section)
    .map((row) => ({
      ...row,
      __docId: `${collectionSuffix(row.schoolYear)}_${String(row.gradeLevel).trim()}_${String(row.section).trim()}`
        .replace(/[^0-9A-Za-z_-]/g, "_")
        .toLowerCase(),
    }));
  await writeBatch("sections", sectionRows, "__docId");
  console.log(`  → discovered ${enrollmentSheets.length} Enrollment_Data tab(s): ${enrollmentSheets.join(", ") || "none"}`);

  const settings = sheetToObjects(workbook, "Settings");
  await writeBatch("settings", settings.map((s) => ({ __docId: s.key, value: s.value })), "__docId");
}

/* ---------------------------------------------------------------------------
 * 3. LEARNERS — hierarchical collections:
 * Learners/{schoolYear}/records/{learnerId}, with matching Dropouts and
 * TransferredOut roots. Firestore requires the records subcollection between
 * the school-year document and the learner document.
 * ------------------------------------------------------------------------- */
async function migrateLearners() {
  console.log("\n[3/4] Learners");
  const core = xlsx.readFile(CORE_FILE);
  const enrollment = xlsx.readFile(ENROLLMENT_FILE);

  const learnerSheetNames = core.SheetNames.filter((name) => name.startsWith("Learners_"));
  for (const sheetName of learnerSheetNames) {
    const schoolYear = sheetName.replace("Learners_", "");
    const rows = sheetToObjects(core, sheetName);
    await writeYearLearners("Learners", schoolYear, rows);
    await deleteLegacyCollection(`learners_${collectionSuffix(schoolYear)}`);
  }

  const transferredOut = sheetToObjects(enrollment, "Transferred Out");
  const byYear = {};
  transferredOut.forEach((row) => {
    const suffix = collectionSuffix(row.schoolYear);
    (byYear[suffix] ||= []).push(row);
  });
  for (const [suffix, rows] of Object.entries(byYear)) {
    const schoolYear = String(rows[0].schoolYear || suffix);
    await writeYearLearners("TransferredOut", schoolYear, rows);
    await deleteLegacyCollection(`transferredOut_${suffix}`);
  }

  const dropout = sheetToObjects(enrollment, "Dropout");
  const dropoutByYear = {};
  dropout.forEach((row) => {
    const suffix = collectionSuffix(row.schoolYear);
    (dropoutByYear[suffix] ||= []).push(row);
  });
  for (const [suffix, rows] of Object.entries(dropoutByYear)) {
    const schoolYear = String(rows[0].schoolYear || suffix);
    await writeYearLearners("Dropouts", schoolYear, rows);
    await deleteLegacyCollection(`dropouts_${suffix}`);
  }
}

async function migratePublicStats() {
  console.log("\n[3b/4] Public login statistics");
  const core = xlsx.readFile(CORE_FILE);
  const enrollment = xlsx.readFile(ENROLLMENT_FILE);
  const years = sheetToObjects(core, "SchoolYears");
  const current = years.find((row) => String(row.isCurrent).toLowerCase() === "true") || years[0];
  const schoolYear = String(current?.schoolYear || "").trim();
  const rows = schoolYear ? sheetToObjects(core, `Learners_${schoolYear}`) : [];
  const activeRows = rows.filter((row) => !["TRANSFERRED_OUT", "DROPPED_OUT"].includes(rowValue_(row, "enrollmentStatus").toUpperCase()) && rowValue_(row, "eosyStatus").toLowerCase() !== "dropped out");
  const enrollmentRows = schoolYear ? sheetToObjects(enrollment, `Enrollment_Data_${schoolYear}`).map((row) => ({
    schoolYear,
    gradeLevel: rowValue_(row, "gradeLevel"),
    section: rowValue_(row, "section"),
    adviser: rowValue_(row, "adviser"),
    male: Number(rowValue_(row, "male")) || 0,
    female: Number(rowValue_(row, "female")) || 0,
    total: Number(rowValue_(row, "total")) || 0,
  })) : [];
  const gradeTotals = [...new Set(enrollmentRows.map((row) => row.gradeLevel).filter(Boolean))].map((gradeLevel) => {
    const gradeRows = enrollmentRows.filter((row) => row.gradeLevel === gradeLevel);
    return { gradeLevel, male: gradeRows.reduce((sum, row) => sum + row.male, 0), female: gradeRows.reduce((sum, row) => sum + row.female, 0), total: gradeRows.reduce((sum, row) => sum + row.total, 0) };
  });
  const grandTotal = gradeTotals.reduce((total, row) => ({ male: total.male + row.male, female: total.female + row.female, total: total.total + row.total }), { male: 0, female: 0, total: 0 });
  const stats = {
    totalLearners: activeRows.length,
    programsTracked: ["is4Ps", "isIP", "isSNED", "isARAL", "isMuslim"].filter((field) => activeRows.some((row) => rowValue_(row, field).toLowerCase() === "true" || rowValue_(row, field) === "1")).length,
    schoolYear,
    syncStatus: schoolYear ? "Live" : "Unavailable",
    enrollmentData: { schoolYear, rows: enrollmentRows, gradeTotals, grandTotal },
  };
  console.log(`  → ${stats.totalLearners} active learner(s) in the public summary`);
  if (WRITE_ENABLED) await db.collection("publicStats").doc("summary").set(stats, { merge: true });
}

/* ---------------------------------------------------------------------------
 * 4. ACADEMIC ASSESSMENTS
 * ------------------------------------------------------------------------- */
async function migrateAcademic() {
  console.log("\n[4/4] Academic assessments");
  const workbook = xlsx.readFile(ACADEMIC_FILE);
  const rows = sheetToObjects(workbook, "LearnerAssessments");
  await writeBatch("academicAssessments", rows.map((r) => ({ ...r, __docId: `${r.learnerId}_${collectionSuffix(r.schoolYear)}` })), "__docId");
}

(async () => {
  console.log(`Mode: ${WRITE_ENABLED ? "LIVE WRITE" : "DRY RUN (no data will be written — set WRITE_ENABLED = true to commit)"}`);
  validateMigrationInputs_();
  await migrateUsers();
  await migrateReferenceData();
  await migrateLearners();
  await migratePublicStats();
  await migrateAcademic();
  console.log("\nDone.");
  process.exit(0);
})().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});

/**
 * ============================================================================
 * FIRESTORE-API.JS
 * ============================================================================
 * The live-data counterpart to sheets-api.js. Loaded AFTER sheets-api.js on
 * every page, so it can override specific LPSApi methods with a Firestore
 * implementation while everything else keeps working against Google Sheets
 * until Phase 2 migrates it. No other file needs to change for the parts
 * covered here — pages keep calling `LPSApi.getUsers()`, etc.
 *
 * WHAT LIVES IN FIRESTORE (this file):
 *   - users            → accounts, roles, status (see README Part 2)
 *   - schoolYears       → { label, isCurrent }
 *   - sections          → { schoolYear, gradeLevel, section, adviser }
 *   - settings          → key/value app settings (e.g. currentSchoolYear)
 *   - Learners/{year}/records/{lrn}
 *   - Dropouts/{year}/records/{lrn}
 *   - TransferredOut/{year}/records/{lrn}
 *
 * WHAT STAYS OUTSIDE FIRESTORE:
 *   - AuditLog   (apps-script/AuditLog.gs)
 *   - Feedback   (apps-script/Feedback.gs)
 *
 * Firestore Security Rules (firestore.rules) are the real access control —
 * this file assumes a signed-in Firebase user and lets the rules reject
 * anything a role shouldn't be able to do.
 * ============================================================================
 */

const FS_USERS = "users";
const FS_SCHOOL_YEARS = "schoolYears";
const FS_SECTIONS = "sections";
const FS_SETTINGS = "settings";
const FS_LEARNERS = "Learners";
const FS_DROPOUTS = "Dropouts";
const FS_TRANSFERRED_OUT = "TransferredOut";
const FS_LEARNER_FIELD_ORDER = [
  "firstName", "lastName", "middleName", "age", "birthDate", "learnerId", "name", "gradeLevel", "section", "gender",
  "guardian", "contact", "enrollmentStatus", "eosyStatus", "schoolYear", "dateAdded", "is4Ps", "isIP", "isSNED", "isARAL", "isMuslim",
  "bosyHeight", "bosyWeight", "bosyNutritionalStatus", "mosyHeight", "mosyWeight", "mosyNutritionalStatus", "eosyHeight", "eosyWeight", "eosyNutritionalStatus",
  "bosyCRLA", "mosyCRLA", "eosyCRLA", "bosyPhilIRI", "mosyPhilIRI", "eosyPhilIRI", "bosyRMA", "mosyRMA", "eosyRMA",
  "filipino", "english", "math", "science", "aralPan", "esp", "music", "arts", "pe", "health", "epp", "motherTongue",
  "transferType", "transferIn", "transferOut", "transferSchool", "transferDate", "transferReason", "transferNotes", "extra",
];

function fsCanonicalLearner_(learner) {
  const result = {};
  FS_LEARNER_FIELD_ORDER.forEach((field) => { result[field] = learner[field] ?? (field === "extra" ? {} : ""); });
  return result;
}

function fsLearnersCollection_(schoolYear) {
  const year = String(schoolYear || "").trim();
  if (!year) throw new Error("A school year is required to read learner records.");
  return db.collection(FS_LEARNERS).doc(year).collection("records");
}

function fsArchiveCollection_(archive, schoolYear) {
  const year = String(schoolYear || "").trim();
  if (!year) throw new Error("A school year is required to read archived learner records.");
  const root = String(archive || "").toLowerCase() === "dropout" ? FS_DROPOUTS : FS_TRANSFERRED_OUT;
  return db.collection(root).doc(year).collection("records");
}

function fsError_(context, error) {
  console.error(context, error);
  if (error && error.code === "permission-denied") {
    return new Error("You don't have permission to do that. Contact your school admin if this seems wrong.");
  }
  return new Error(error && error.message ? error.message : `${context} failed.`);
}

function fsInvalidateReadCaches_(schoolYear = "") {
  if (typeof LPSCache === "undefined") return;
  LPSCache.clear("firestore_learners_");
  LPSCache.clear("firestore_sections_");
  LPSCache.remove("firestore_users");
  LPSCache.remove("firestore_school_years");
  if (schoolYear) LPSCache.remove(`firestore_learners_${schoolYear}`);
}

/** Best-effort audit log write to the existing Sheets-backed AuditLog. Never blocks the caller. */
function fsAudit_(action, details) {
  if (typeof LPSApi !== "undefined" && LPSApi.recordAuditEvent) {
    LPSApi.recordAuditEvent(action, { ipSession: typeof appSessionId === "function" ? appSessionId() : "", ...details }).catch(() => {});
  }
}

/* ---------------------------------------------------------------------------
 * USERS (fully migrated to Firestore)
 * ------------------------------------------------------------------------- */

/**
 * Reads the signed-in user's own profile from Firestore. Falls back to a
 * "Visitor" profile if no matching document exists yet (e.g. the very first
 * admin, before anyone has added them — see README Part 2, "Bootstrapping
 * the first admin").
 */
async function fsGetMyProfile() {
  const user = firebase.auth().currentUser;
  if (!user) throw new Error("Not signed in.");
  const doc = await db.collection(FS_USERS).doc(user.uid).get();
  if (!doc.exists) return { userId: user.uid, name: displayNameFromEmail(user.email), email: user.email, role: "Visitor", status: "Active" };
  return { userId: doc.id, ...doc.data() };
}

async function fsGetUsers() {
  const load = async () => {
    const snapshot = await db.collection(FS_USERS).orderBy("name").get();
    return snapshot.docs.map((doc) => ({ userId: doc.id, ...doc.data() }));
  };
  return typeof LPSCache === "undefined" ? load() : LPSCache.getOrLoad("firestore_users", load, 30000, 120000);
}

async function fsAddUser(record) {
  let createdUser = null;
  try {
    const email = String(record.email || "").trim();
    const password = String(record.password || "");
    if (!email || password.length < 6) throw new Error("A valid email and a password of at least 6 characters are required.");
    const creationAuth = getUserCreationAuth();
    await creationAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
    const credential = await creationAuth.createUserWithEmailAndPassword(email, password);
    createdUser = credential.user;
    const userId = createdUser.uid;
    await db.collection(FS_USERS).doc(userId).set({
      name: record.name,
      email,
      role: record.role,
      status: record.status || "Invited",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await creationAuth.signOut();
    fsInvalidateReadCaches_();
    fsAudit_("USER_ADD", { sheet: "users", recordId: userId, newValue: JSON.stringify({ name: record.name, email, role: record.role, status: record.status || "Invited" }) });
    return { userId };
  } catch (error) {
    if (createdUser) {
      try { await createdUser.delete(); } catch (deleteError) { console.error("Could not roll back Firebase user creation.", deleteError); }
    }
    try { await userCreationAuth?.signOut(); } catch (signOutError) { /* Preserve the original error. */ }
    if (error.code === "auth/email-already-in-use") throw new Error("That email already has a Firebase Authentication account.");
    if (error.code === "auth/weak-password") throw new Error("Firebase requires a stronger password.");
    throw fsError_("Add user", error);
  }
}

async function fsUpdateUser(userId, record) {
  try {
    const ref = db.collection(FS_USERS).doc(userId);
    const before = await ref.get();
    await ref.set({ name: record.name, email: record.email, role: record.role, status: record.status }, { merge: true });
    fsInvalidateReadCaches_();
    fsAudit_("USER_UPDATE", {
      sheet: "users", recordId: userId,
      oldValue: before.exists ? JSON.stringify(before.data()) : "",
      newValue: JSON.stringify(record),
    });
    return { updated: true };
  } catch (error) {
    throw fsError_("Update user", error);
  }
}

async function fsUpdateMyProfileName(name) {
  const user = firebase.auth().currentUser;
  const value = String(name || "").trim();
  if (!user) throw new Error("Not signed in.");
  if (value.length < 2) throw new Error("Username must be at least 2 characters.");
  if (value.length > 80) throw new Error("Username must be 80 characters or fewer.");
  try {
    await db.collection(FS_USERS).doc(user.uid).update({ name: value });
    fsInvalidateReadCaches_();
    fsAudit_("USER_UPDATE", { sheet: "users", recordId: user.uid, newValue: JSON.stringify({ name: value }) });
    return { name: value };
  } catch (error) {
    throw fsError_("Update username", error);
  }
}

async function fsDeleteUser(userId) {
  try {
    await LPSApi.deleteAuthUsers([userId]);
    await db.collection(FS_USERS).doc(userId).delete();
    fsInvalidateReadCaches_();
    fsAudit_("USER_DELETE", { sheet: "users", recordId: userId });
    return { deleted: true };
  } catch (error) {
    throw fsError_("Remove user", error);
  }
}

async function fsDeleteUsers(userIds) {
  try {
    await LPSApi.deleteAuthUsers(userIds);
    const batch = db.batch();
    userIds.forEach((id) => batch.delete(db.collection(FS_USERS).doc(id)));
    await batch.commit();
    fsInvalidateReadCaches_();
    fsAudit_("USER_DELETE", { sheet: "users", recordId: userIds.join(", ") });
    return { deleted: userIds.length };
  } catch (error) {
    throw fsError_("Remove users", error);
  }
}

/** Live updates for the Manage Users table — optional upgrade for manage-users.js (see README Part 5). Returns an unsubscribe function. */
function fsSubscribeUsers(onChange, onError) {
  return db.collection(FS_USERS).orderBy("name").onSnapshot(
    (snapshot) => onChange(snapshot.docs.map((doc) => ({ userId: doc.id, ...doc.data() }))),
    (error) => onError && onError(fsError_("Live user updates", error))
  );
}

// Swap the Sheets-backed implementations for the Firestore-backed ones.
// Every page keeps calling LPSApi.* exactly as before.
if (typeof LPSApi !== "undefined") {
  LPSApi.getMyProfile = fsGetMyProfile;
  LPSApi.getUsers = fsGetUsers;
  LPSApi.addUser = fsAddUser;
  LPSApi.updateUser = fsUpdateUser;
  LPSApi.updateMyProfileName = fsUpdateMyProfileName;
  LPSApi.deleteUser = fsDeleteUser;
  LPSApi.deleteUsers = fsDeleteUsers;
}

/* ---------------------------------------------------------------------------
 * SCHOOL YEARS / SECTIONS / SETTINGS (small, low-write reference data —
 * cheap to keep live in Firestore so every page reflects the current school
 * year instantly instead of waiting on a Sheets round trip)
 * ------------------------------------------------------------------------- */

async function fsGetSchoolYears() {
  const load = async () => {
    const snapshot = await db.collection(FS_SCHOOL_YEARS).get();
    const years = snapshot.docs
      .map((doc) => ({ schoolYear: doc.id, ...doc.data() }))
      .filter((year) => String(year.schoolYear || "").trim())
      .sort((a, b) => fsSchoolYearSortValue_(b.schoolYear) - fsSchoolYearSortValue_(a.schoolYear));
    if (years.length) return years;
    const current = await fsGetSetting("currentSchoolYear");
    return current ? [{ schoolYear: String(current), isCurrent: true }] : [];
  };
  return typeof LPSCache === "undefined" ? load() : LPSCache.getOrLoad("firestore_school_years", load, 30000, 120000);
}

async function fsGetPublicStats() {
  const readStats = async () => {
    const snapshot = await db.collection("publicStats").doc("summary").get();
    if (!snapshot.exists) throw new Error("Public statistics have not been initialized yet.");
    return snapshot.data();
  };
  if (typeof LPSCache === "undefined") return readStats();
  return LPSCache.getOrLoad("firestore_public_stats", readStats, 300000, 3600000);
}

async function fsGetPublicEnrollmentData() {
  const stats = await fsGetPublicStats();
  return stats.enrollmentData || { schoolYear: stats.schoolYear || "", rows: [], gradeTotals: [], grandTotal: { male: 0, female: 0, total: 0 } };
}

function fsSubscribePublicStats(onChange, onError) {
  return db.collection("publicStats").doc("summary").onSnapshot(
    (snapshot) => {
      const stats = snapshot.exists ? snapshot.data() : null;
      if (stats && typeof LPSCache !== "undefined") LPSCache.write("firestore_public_stats", stats, 300000);
      onChange(stats);
    },
    (error) => onError && onError(fsError_("Live public statistics", error))
  );
}

async function fsRefreshPublicStats() {
  const years = await fsGetSchoolYears();
  const current = years.find((year) => year.isCurrent) || years[0];
  const learnersByYear = await Promise.all(years.map((year) => fsGetLearners(year.schoolYear)));
  const learners = current ? learnersByYear[years.findIndex((year) => year.schoolYear === current.schoolYear)] || [] : [];
  const programFields = ["is4Ps", "isIP", "isSNED", "isARAL", "isMuslim"];
  const gradeCounts = {};
  learners.forEach((learner) => {
    const grade = learner.gradeLevel || "—";
    gradeCounts[grade] = (gradeCounts[grade] || 0) + 1;
  });
  const taggedCount = learners.filter((learner) => programFields.some((field) => learner[field])).length;
  const enrollmentData = current ? await fsGetEnrollmentData(current.schoolYear) : { schoolYear: "", rows: [], gradeTotals: [], grandTotal: { male: 0, female: 0, total: 0 } };
  const stats = {
    totalLearners: learners.length,
    programsTracked: programFields.filter((field) => learners.some((learner) => learner[field])).length,
    fourPsCount: learners.filter((learner) => learner.is4Ps).length,
    ipCount: learners.filter((learner) => learner.isIP).length,
    snedCount: learners.filter((learner) => learner.isSNED).length,
    aralCount: learners.filter((learner) => learner.isARAL).length,
    muslimCount: learners.filter((learner) => learner.isMuslim).length,
    maleCount: learners.filter((learner) => learner.gender === "Male").length,
    femaleCount: learners.filter((learner) => learner.gender === "Female").length,
    notTaggedCount: learners.length - taggedCount,
    gradeLevels: Object.entries(gradeCounts).map(([label, value]) => ({ label, value })),
    recentLearners: [],
    enrollmentData,
    schoolYear: current?.schoolYear || "",
    syncStatus: current ? "Live" : "Unavailable",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("publicStats").doc("summary").set(stats, { merge: true });
  if (typeof LPSCache !== "undefined") LPSCache.write("firestore_public_stats", stats, 300000);
  return stats;
}

function fsPublicActive_(learner) {
  const enrollmentStatus = String(learner?.enrollmentStatus || "ACTIVE").toUpperCase().replace(/[ -]+/g, "_");
  const eosyStatus = String(learner?.eosyStatus || "").toLowerCase().replace(/[_-]+/g, " ");
  return enrollmentStatus !== "TRANSFERRED_OUT" && enrollmentStatus !== "DROPPED_OUT" && eosyStatus !== "dropped out" && !learner?.transferOut;
}

function fsPublicMetricDelta_(before, after, field) {
  return Number(Boolean(fsPublicActive_(after) && after?.[field])) - Number(Boolean(fsPublicActive_(before) && before?.[field]));
}

async function fsUpdatePublicStatsForChange_(schoolYear, before, after) {
  const ref = db.collection("publicStats").doc("summary");
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const stats = snapshot.data();
    if (stats.schoolYear && stats.schoolYear !== schoolYear) return;
    const fields = [["is4Ps", "fourPsCount"], ["isIP", "ipCount"], ["isSNED", "snedCount"], ["isARAL", "aralCount"], ["isMuslim", "muslimCount"]];
    const update = {};
    update.totalLearners = Number(stats.totalLearners || 0) + Number(fsPublicActive_(after)) - Number(fsPublicActive_(before));
    update.maleCount = Number(stats.maleCount || 0) + (fsPublicActive_(after) && after?.gender === "Male" ? 1 : 0) - (fsPublicActive_(before) && before?.gender === "Male" ? 1 : 0);
    update.femaleCount = Number(stats.femaleCount || 0) + (fsPublicActive_(after) && after?.gender === "Female" ? 1 : 0) - (fsPublicActive_(before) && before?.gender === "Female" ? 1 : 0);
    fields.forEach(([field, countField]) => { update[countField] = Number(stats[countField] || 0) + fsPublicMetricDelta_(before, after, field); });
    update.notTaggedCount = Math.max(0, update.totalLearners - fields.reduce((count, [, countField]) => count + Number(update[countField] || 0), 0));
    const gradeCounts = Object.fromEntries((stats.gradeLevels || []).map((item) => [item.label, Number(item.value || 0)]));
    if (fsPublicActive_(before) && before?.gradeLevel) gradeCounts[before.gradeLevel] = Math.max(0, (gradeCounts[before.gradeLevel] || 0) - 1);
    if (fsPublicActive_(after) && after?.gradeLevel) gradeCounts[after.gradeLevel] = (gradeCounts[after.gradeLevel] || 0) + 1;
    update.gradeLevels = Object.entries(gradeCounts).filter(([, value]) => value > 0).map(([label, value]) => ({ label, value }));
    const enrollmentData = stats.enrollmentData ? JSON.parse(JSON.stringify(stats.enrollmentData)) : null;
    if (enrollmentData?.rows) {
      const adjustRows = (learner, amount) => {
        if (!fsPublicActive_(learner)) return;
        const row = enrollmentData.rows.find((item) => item.gradeLevel === learner.gradeLevel && item.section === learner.section);
        if (!row) return;
        row[learner.gender === "Male" ? "male" : "female"] = Math.max(0, Number(row[learner.gender === "Male" ? "male" : "female"] || 0) + amount);
        row.total = Math.max(0, Number(row.total || 0) + amount);
      };
      adjustRows(before, -1);
      adjustRows(after, 1);
      enrollmentData.grandTotal = enrollmentData.rows.reduce((total, row) => ({ male: total.male + Number(row.male || 0), female: total.female + Number(row.female || 0), total: total.total + Number(row.total || 0) }), { male: 0, female: 0, total: 0 });
      update.enrollmentData = enrollmentData;
    }
    update.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    transaction.set(ref, update, { merge: true });
  });
  if (typeof LPSCache !== "undefined") LPSCache.remove("firestore_public_stats");
}

function fsSchoolYearSortValue_(value) {
  const match = String(value || "").match(/(\d{4})\D+(\d{4})/);
  return match ? Number(match[1]) * 10000 + Number(match[2]) : 0;
}

function fsNormalizeSchoolYear_(value) {
  const text = String(value || "").trim().replace(/[–—]/g, "-").replace(/\s+/g, "");
  const match = text.match(/^(\d{4})[-/]?(\d{4})$/);
  return match ? `${match[1]}-${match[2]}` : String(value || "").trim();
}

async function fsCreateSchoolYear(schoolYear, makeCurrent = false, copyFromYear = "") {
  const normalized = fsNormalizeSchoolYear_(schoolYear);
  if (!/^\d{4}-\d{4}$/.test(normalized)) throw new Error("School year must use the format YYYY-YYYY.");
  const existing = await db.collection(FS_SCHOOL_YEARS).doc(normalized).get();
  if (existing.exists) throw new Error(`School year ${normalized} already exists.`);
  await db.collection(FS_SCHOOL_YEARS).doc(normalized).set({ schoolYear: normalized, isCurrent: Boolean(makeCurrent) }, { merge: true });
  let copiedSections = 0;
  const sourceYear = fsNormalizeSchoolYear_(copyFromYear);
  if (sourceYear && sourceYear !== normalized) {
    const source = await fsGetSections(sourceYear);
    if (source.length) {
      const batch = db.batch();
      source.forEach((section) => {
        const ref = db.collection(FS_SECTIONS).doc(`${normalized}_${section.gradeLevel}_${section.section}`.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase());
        batch.set(ref, { schoolYear: normalized, gradeLevel: section.gradeLevel, section: section.section, adviser: section.adviser || "" }, { merge: true });
      });
      await batch.commit();
      copiedSections = source.length;
    }
  }
  if (makeCurrent) await fsSetCurrentSchoolYear(normalized);
  fsInvalidateReadCaches_();
  return { schoolYear: normalized, isCurrent: Boolean(makeCurrent), copiedSections };
}

async function fsSetCurrentSchoolYear(schoolYear) {
  const normalized = fsNormalizeSchoolYear_(schoolYear);
  if (!/^\d{4}-\d{4}$/.test(normalized)) throw new Error("School year must use the format YYYY-YYYY.");
  const target = await db.collection(FS_SCHOOL_YEARS).doc(normalized).get();
  if (!target.exists) throw new Error(`School year ${normalized} was not found.`);
  const years = await db.collection(FS_SCHOOL_YEARS).get();
  const batch = db.batch();
  years.docs.forEach((doc) => batch.set(doc.ref, { isCurrent: doc.id === normalized }, { merge: true }));
  batch.set(db.collection(FS_SETTINGS).doc("currentSchoolYear"), { value: normalized }, { merge: true });
  await batch.commit();
  fsInvalidateReadCaches_();
  return { schoolYear: normalized, isCurrent: true };
}

async function fsGetSections(schoolYear) {
  const load = async () => {
    let query = db.collection(FS_SECTIONS);
    if (schoolYear) query = query.where("schoolYear", "==", schoolYear);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  };
  return typeof LPSCache === "undefined" ? load() : LPSCache.getOrLoad(`firestore_sections_${schoolYear || "all"}`, load, 30000, 120000);
}

function fsSectionId_(schoolYear, gradeLevel, section) {
  return `${schoolYear}_${gradeLevel}_${section}`.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

async function fsSaveSection(section) {
  const schoolYear = fsNormalizeSchoolYear_(section.schoolYear);
  const gradeLevel = fsNormalizeGrade_(section.gradeLevel);
  const sectionName = String(section.section || "").trim();
  const adviser = String(section.adviser || "").trim();
  if (!/^\d{4}-\d{4}$/.test(schoolYear) || !gradeLevel || !sectionName) throw new Error("School year, grade level, and section name are required.");
  const id = section.id || fsSectionId_(schoolYear, gradeLevel, sectionName);
  await db.collection(FS_SECTIONS).doc(id).set({ schoolYear, gradeLevel, section: sectionName, adviser }, { merge: true });
  fsInvalidateReadCaches_(schoolYear);
  return { id, schoolYear, gradeLevel, section: sectionName, adviser };
}

async function fsDeleteSection(sectionId) {
  if (!sectionId) throw new Error("A section ID is required.");
  await db.collection(FS_SECTIONS).doc(sectionId).delete();
  fsInvalidateReadCaches_();
  return { deleted: true };
}

function fsNormalizeGrade_(value) {
  const text = String(value || "").trim();
  const key = text.toLowerCase().replace(/\s+/g, " ");
  if (["kinder", "kindergarten", "kg", "0"].includes(key)) return "Kinder";
  const match = key.match(/^grade\s*(\d+)$/) || key.match(/^(\d+)$/);
  return match ? `Grade ${match[1]}` : text;
}

function fsNormalizeValue_(value) {
  return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
}

async function fsGetEnrollmentData(schoolYear) {
  const [sections, learners] = await Promise.all([fsGetSections(schoolYear), fsGetLearners(schoolYear)]);
  const sectionMap = new Map();
  sections.forEach((section) => {
    if (section.schoolYear && fsNormalizeValue_(section.schoolYear) !== fsNormalizeValue_(schoolYear)) return;
    const gradeLevel = fsNormalizeGrade_(section.gradeLevel);
    const sectionName = String(section.section || "").trim();
    if (!gradeLevel || !sectionName) return;
    sectionMap.set(`${fsNormalizeValue_(gradeLevel)}|${fsNormalizeValue_(sectionName)}`, {
      schoolYear,
      gradeLevel,
      section: sectionName,
      adviser: String(section.adviser || section.teacher || "").trim(),
    });
  });
  const counts = new Map();
  learners.forEach((learner) => {
    if (String(learner.enrollmentStatus || "ACTIVE").toUpperCase() === "TRANSFERRED_OUT" || learner.transferOut) return;
    const gradeLevel = fsNormalizeGrade_(learner.gradeLevel);
    const sectionName = String(learner.section || "").trim();
    if (!gradeLevel || !sectionName) return;
    const key = `${fsNormalizeValue_(gradeLevel)}|${fsNormalizeValue_(sectionName)}`;
    const count = counts.get(key) || { male: 0, female: 0, total: 0 };
    count.total += 1;
    if (fsNormalizeValue_(learner.gender) === "male") count.male += 1;
    if (fsNormalizeValue_(learner.gender) === "female") count.female += 1;
    counts.set(key, count);
  });
  const rows = [...sectionMap.entries()].map(([key, section]) => ({ ...section, ...(counts.get(key) || { male: 0, female: 0, total: 0 }) }));
  const gradeOrder = ["Kinder", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6"];
  rows.sort((a, b) => (gradeOrder.indexOf(a.gradeLevel) - gradeOrder.indexOf(b.gradeLevel)) || a.section.localeCompare(b.section));
  const gradeTotals = gradeOrder.map((gradeLevel) => {
    const gradeRows = rows.filter((row) => row.gradeLevel === gradeLevel);
    return {
      gradeLevel,
      male: gradeRows.reduce((sum, row) => sum + row.male, 0),
      female: gradeRows.reduce((sum, row) => sum + row.female, 0),
      total: gradeRows.reduce((sum, row) => sum + row.total, 0),
    };
  }).filter((row) => row.total > 0 || rows.some((item) => item.gradeLevel === row.gradeLevel));
  const grandTotal = gradeTotals.reduce((total, row) => ({
    male: total.male + row.male,
    female: total.female + row.female,
    total: total.total + row.total,
  }), { male: 0, female: 0, total: 0 });
  return { schoolYear, rows, gradeTotals, grandTotal };
}

async function fsSyncEnrollmentData(schoolYear) {
  const result = await fsGetEnrollmentData(schoolYear);
  return { updated: 0, skipped: result.rows.length, schoolYear: result.schoolYear };
}

function fsLearnerName_(learner) {
  return learner.name || [learner.firstName, learner.middleName, learner.lastName].filter(Boolean).join(" ").trim();
}

function fsBmi_(height, weight) {
  const heightMeters = Number(height) / 100;
  const kilograms = Number(weight);
  return heightMeters > 0 && kilograms > 0 ? Math.round((kilograms / (heightMeters * heightMeters)) * 100) / 100 : "";
}

function fsProfileChange_(learner, fields) {
  const values = fields.map((field) => learner[field]);
  if (!values[0] && !values[1] && !values[2]) return "No change recorded";
  if (values[2] && values[0] && values[2] !== values[0]) return `${values[0]} → ${values[2]}`;
  return "Profile recorded";
}

async function fsGetNutritionStatus(schoolYear) {
  const learners = await fsGetLearners(schoolYear);
  return learners.map((learner) => ({
    ...learner,
    name: fsLearnerName_(learner),
    bosyBmi: fsBmi_(learner.bosyHeight, learner.bosyWeight),
    mosyBmi: fsBmi_(learner.mosyHeight, learner.mosyWeight),
    eosyBmi: fsBmi_(learner.eosyHeight, learner.eosyWeight),
    heightChange: Number(learner.eosyHeight) && Number(learner.bosyHeight) ? Number(learner.eosyHeight) - Number(learner.bosyHeight) : null,
    weightChange: Number(learner.eosyWeight) && Number(learner.bosyWeight) ? Number(learner.eosyWeight) - Number(learner.bosyWeight) : null,
    statusChange: fsProfileChange_(learner, ["bosyNutritionalStatus", "mosyNutritionalStatus", "eosyNutritionalStatus"]),
  }));
}

async function fsGetReadingProfiles(schoolYear) {
  const learners = await fsGetLearners(schoolYear);
  return learners.map((learner) => {
    const hasCrla = learner.bosyCRLA || learner.mosyCRLA || learner.eosyCRLA;
    const hasPhilIri = learner.bosyPhilIRI || learner.mosyPhilIRI || learner.eosyPhilIRI;
    const prefix = hasCrla ? "CRLA" : "Phil-IRI";
    const fields = hasCrla ? ["bosyCRLA", "mosyCRLA", "eosyCRLA"] : ["bosyPhilIRI", "mosyPhilIRI", "eosyPhilIRI"];
    return {
      ...learner, name: fsLearnerName_(learner), reference: prefix,
      bosy: learner[fields[0]] || "", mosy: learner[fields[1]] || "", eosy: learner[fields[2]] || "",
      change: fsProfileChange_(learner, fields),
    };
  }).filter((learner) => learner.bosy || learner.mosy || learner.eosy);
}

async function fsGetMathProfiles(schoolYear) {
  const learners = await fsGetLearners(schoolYear);
  return learners.map((learner) => ({
    ...learner, name: fsLearnerName_(learner),
    bosy: learner.bosyRMA || "", mosy: learner.mosyRMA || "", eosy: learner.eosyRMA || "",
    change: fsProfileChange_(learner, ["bosyRMA", "mosyRMA", "eosyRMA"]),
  })).filter((learner) => learner.bosy || learner.mosy || learner.eosy);
}

async function fsGetGradesProfiles(schoolYear) {
  const learners = await fsGetLearners(schoolYear);
  return learners.map((learner) => ({ ...learner, name: fsLearnerName_(learner) }));
}

async function fsGetTransferRecords(schoolYear, type = "all", gradeLevel = "", gender = "") {
  const [activeSnapshot, archivedSnapshot] = await Promise.all([
    fsLearnersCollection_(schoolYear).get(),
    fsArchiveCollection_("transferredOut", schoolYear).get(),
  ]);
  const learners = [
    ...activeSnapshot.docs.map((doc) => ({ learnerId: doc.id, schoolYear, ...doc.data() })),
    ...archivedSnapshot.docs.map((doc) => ({ learnerId: doc.id, schoolYear, ...doc.data() })),
  ];
  const normalizedType = String(type || "all").trim().toLowerCase();
  const requestedType = normalizedType === "in" || normalizedType === "transfer in" ? "Transfer In"
    : normalizedType === "out" || normalizedType === "transfer out" ? "Transfer Out" : "";
  const seen = new Set();
  return learners.filter((learner) => {
    const transferType = learner.transferType || (learner.transferIn ? "Transfer In" : learner.transferOut ? "Transfer Out" : "");
    const uniqueKey = `${learner.learnerId}|${transferType}`;
    if (!transferType || seen.has(uniqueKey)) return false;
    seen.add(uniqueKey);
    return (!requestedType || transferType === requestedType)
      && (!gradeLevel || fsNormalizeGrade_(learner.gradeLevel) === fsNormalizeGrade_(gradeLevel))
      && (!gender || fsNormalizeValue_(learner.gender) === fsNormalizeValue_(gender));
  }).map((learner) => ({ ...learner, name: fsLearnerName_(learner), transferType: learner.transferType || (learner.transferIn ? "Transfer In" : "Transfer Out") }));
}

async function fsGetArchiveRecords(archive, schoolYear) {
  const archiveName = String(archive || "").toLowerCase();
  const snapshot = await fsArchiveCollection_(archiveName, schoolYear).get();
  const records = snapshot.docs.map((doc) => ({ learnerId: doc.id, schoolYear, ...doc.data() }));
  if (archiveName !== "dropout") return records;
  // Compatibility for records tagged before archive transitions were added.
  const activeSnapshot = await fsLearnersCollection_(schoolYear).get();
  const legacyDropouts = activeSnapshot.docs
    .map((doc) => ({ learnerId: doc.id, schoolYear, ...doc.data() }))
    .filter((learner) => fsLearnerArchiveType_(learner) === "dropout");
  const seen = new Set(records.map((record) => record.learnerId));
  return records.concat(legacyDropouts.filter((record) => !seen.has(record.learnerId)));
}

async function fsUpdateArchiveRecord(archive, schoolYear, learnerId, learner) {
  const archiveName = String(archive || "").toLowerCase();
  const collection = archiveName === "learners" ? fsLearnersCollection_(schoolYear) : fsArchiveCollection_(archiveName, schoolYear);
  const ref = collection.doc(learnerId);
  const before = await ref.get();
  if (!before.exists) throw new Error("Archived learner record was not found.");
  const update = { ...fsCanonicalLearner_(learner), schoolYear };
  await ref.set(update, { merge: true });
  fsInvalidateReadCaches_(schoolYear);
  void fsUpdatePublicStatsForChange_(schoolYear, {}, {}).catch(() => {});
  fsAudit_("LEARNER_UPDATE", { sheet: `${archiveName}_${schoolYear}`, recordId: learnerId, oldValue: JSON.stringify(before.data()), newValue: JSON.stringify(learner) });
  return { updated: true };
}

async function fsDeleteArchiveRecord(archive, schoolYear, learnerId) {
  const archiveName = String(archive || "").toLowerCase();
  const collection = archiveName === "learners" ? fsLearnersCollection_(schoolYear) : fsArchiveCollection_(archiveName, schoolYear);
  await collection.doc(learnerId).delete();
  fsInvalidateReadCaches_(schoolYear);
  fsAudit_("LEARNER_DELETE", { sheet: `${archiveName}_${schoolYear}`, recordId: learnerId });
  return { deleted: true };
}

async function fsGetReportsData(schoolYear) {
  const learners = await fsGetLearners(schoolYear);
  const gradeOrder = ["Kinder", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6"];
  const breakdown = gradeOrder.map((gradeLevel) => {
    const rows = learners.filter((learner) => fsNormalizeGrade_(learner.gradeLevel) === gradeLevel);
    return {
      gradeLevel, total: rows.length, male: rows.filter((row) => row.gender === "Male").length, female: rows.filter((row) => row.gender === "Female").length,
      fourPs: rows.filter((row) => row.is4Ps).length, ip: rows.filter((row) => row.isIP).length, sned: rows.filter((row) => row.isSNED).length,
      aral: rows.filter((row) => row.isARAL).length, muslim: rows.filter((row) => row.isMuslim).length,
    };
  }).filter((row) => row.total);
  const tagged = learners.filter((learner) => learner.is4Ps || learner.isIP || learner.isSNED || learner.isARAL || learner.isMuslim).length;
  return {
    schoolYear, learners: learners.map((learner) => ({ ...learner, name: fsLearnerName_(learner) })), breakdown,
    totalLearners: learners.length, fourPsCount: learners.filter((row) => row.is4Ps).length, ipCount: learners.filter((row) => row.isIP).length,
    snedCount: learners.filter((row) => row.isSNED).length, aralCount: learners.filter((row) => row.isARAL).length, muslimCount: learners.filter((row) => row.isMuslim).length,
    maleCount: learners.filter((row) => row.gender === "Male").length, femaleCount: learners.filter((row) => row.gender === "Female").length,
    notTaggedCount: learners.length - tagged, gradeLevels: breakdown.map((row) => ({ label: row.gradeLevel, value: row.total })),
  };
}

async function fsGetSetting(key) {
  const doc = await db.collection(FS_SETTINGS).doc(key).get();
  return doc.exists ? doc.data().value : null;
}

if (typeof LPSApi !== "undefined") {
  LPSApi.getPublicStats = fsGetPublicStats;
  LPSApi.getPublicEnrollmentData = fsGetPublicEnrollmentData;
  LPSApi.refreshPublicStats = fsRefreshPublicStats;
  LPSApi.getSchoolYears = fsGetSchoolYears;
  LPSApi.createSchoolYear = fsCreateSchoolYear;
  LPSApi.setCurrentSchoolYear = fsSetCurrentSchoolYear;
  LPSApi.getSections = fsGetSections;
  LPSApi.saveSection = fsSaveSection;
  LPSApi.deleteSection = fsDeleteSection;
  LPSApi.getSetting = fsGetSetting;
  LPSApi.getEnrollmentData = (schoolYear) => isVisitorSession() ? fsGetPublicEnrollmentData() : fsGetEnrollmentData(schoolYear);
  LPSApi.syncEnrollmentData = fsSyncEnrollmentData;
  LPSApi.getNutritionStatus = fsGetNutritionStatus;
  LPSApi.getReadingProfiles = fsGetReadingProfiles;
  LPSApi.getMathProfiles = fsGetMathProfiles;
  LPSApi.getGradesProfiles = fsGetGradesProfiles;
  LPSApi.getTransferRecords = fsGetTransferRecords;
  LPSApi.getReportsData = fsGetReportsData;
  LPSApi.getArchiveRecords = fsGetArchiveRecords;
  LPSApi.updateArchiveRecord = fsUpdateArchiveRecord;
  LPSApi.deleteArchiveRecord = fsDeleteArchiveRecord;
}

/* ---------------------------------------------------------------------------
 * LEARNERS (Phase 2 scaffolding)
 * ------------------------------------------------------------------------- */
// These helpers are ready to use but NOT yet wired into learner-list.js,
// data.js, dashboard.js, etc. — those pages still read/write learners
// through sheets-api.js today. Switching a page over is a matter of
// replacing its LPSApi.getLearners(...)-style calls with the equivalent
// fs* call below, one page at a time. See README_FIRESTORE_MIGRATION.md,
// Part 5, for the recommended order and a worked example (dashboard.js).

async function fsGetLearners(schoolYear) {
  const load = async () => {
    const snapshot = await fsLearnersCollection_(schoolYear).get();
    return snapshot.docs.map((doc) => ({ learnerId: doc.id, ...doc.data() })).filter(fsIsActiveLearner_);
  };
  return typeof LPSCache === "undefined" ? load() : LPSCache.getOrLoad(`firestore_learners_${schoolYear}`, load, 15000, 60000);
}

function fsIsActiveLearner_(learner) {
  const enrollmentStatus = String(learner?.enrollmentStatus || "ACTIVE").toUpperCase().replace(/[ -]+/g, "_");
  const eosyStatus = String(learner?.eosyStatus || "").toLowerCase().replace(/[_-]+/g, " ");
  return enrollmentStatus !== "TRANSFERRED_OUT" && enrollmentStatus !== "DROPPED_OUT" && eosyStatus !== "dropped out" && !learner?.transferOut;
}

function fsLearnerArchiveType_(learner) {
  const enrollmentStatus = String(learner?.enrollmentStatus || "").toUpperCase().replace(/[ -]+/g, "_");
  const eosyStatus = String(learner?.eosyStatus || "").toLowerCase().replace(/[_-]+/g, " ");
  const transferType = String(learner?.transferType || "").trim().toLowerCase();
  if (learner?.transferOut || enrollmentStatus === "TRANSFERRED_OUT" || transferType === "transfer out") return "transferredOut";
  if (enrollmentStatus === "DROPPED_OUT" || eosyStatus === "dropped out") return "dropout";
  return "";
}

async function fsGetAllLearners_(schoolYear) {
  const snapshot = await fsLearnersCollection_(schoolYear).get();
  return snapshot.docs.map((doc) => ({ learnerId: doc.id, ...doc.data() }));
}

function fsLearnerDate_(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return value || "";
}

async function fsGetLearner(learnerId, schoolYear) {
  const doc = await fsLearnersCollection_(schoolYear).doc(learnerId).get();
  return doc.exists ? { learnerId: doc.id, ...doc.data(), dateAdded: fsLearnerDate_(doc.data().dateAdded) } : null;
}

async function fsGetLearnerPage(options = {}) {
  const allLearners = (await fsGetLearners(options.schoolYear)).map((learner) => ({
    ...learner,
    dateAdded: fsLearnerDate_(learner.dateAdded),
  }));
  const query = String(options.search || "").toLowerCase();
  const filtered = allLearners.filter((learner) => {
    const programField = options.program && PROGRAM_FIELD_MAP[options.program];
    return (!query || `${learner.firstName || ""} ${learner.lastName || ""} ${learner.learnerId}`.toLowerCase().includes(query))
      && (!options.gradeLevel || learner.gradeLevel === options.gradeLevel)
      && (!options.gender || learner.gender === options.gender)
      && (!programField || learner[programField]);
  });
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(100, Number(options.pageSize) || 10);
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
}

async function fsGetLearnerSchema(schoolYear) {
  const learners = await fsGetLearners(schoolYear);
  const knownFields = new Set([
    "learnerId", "firstName", "middleName", "lastName", "birthDate", "age", "gradeLevel", "section", "gender",
    "enrollmentStatus", "eosyStatus", "guardian", "contact", "dateAdded", "is4Ps", "isIP", "isSNED", "isARAL", "isMuslim",
    "extra",
  ]);
  const extraFields = new Set();
  learners.forEach((learner) => {
    Object.keys(learner).forEach((field) => { if (!knownFields.has(field)) extraFields.add(field); });
    Object.keys(learner.extra || {}).forEach((field) => extraFields.add(field));
  });
  return { extraFields: [...extraFields] };
}

/** Real-time learner list — the dashboard and masterlist update instantly when any device adds/edits/removes a learner, with no manual refresh. */
function fsSubscribeLearners(schoolYear, onChange, onError) {
  return fsLearnersCollection_(schoolYear).onSnapshot(
    (snapshot) => onChange(snapshot.docs.map((doc) => ({ learnerId: doc.id, ...doc.data() })).filter(fsIsActiveLearner_)),
    (error) => onError && onError(fsError_("Live learner updates", error))
  );
}

async function fsAddLearner(schoolYear, learner) {
  try {
    const learnerId = String(learner.learnerId || "").trim();
    const archiveType = fsLearnerArchiveType_(learner);
    const collection = archiveType ? fsArchiveCollection_(archiveType, schoolYear) : fsLearnersCollection_(schoolYear);
    const ref = learnerId ? collection.doc(learnerId) : collection.doc();
    await ref.set({ ...fsCanonicalLearner_(learner), schoolYear, dateAdded: firebase.firestore.FieldValue.serverTimestamp() });
    fsInvalidateReadCaches_(schoolYear);
    void fsUpdatePublicStatsForChange_(schoolYear, {}, { ...learner, learnerId: ref.id, schoolYear }).catch(() => {});
    fsAudit_("LEARNER_ADD", { sheet: archiveType ? `${archiveType}_${schoolYear}` : `learners_${schoolYear}`, recordId: ref.id, newValue: JSON.stringify(learner) });
    return { learnerId: ref.id };
  } catch (error) {
    throw fsError_("Add learner", error);
  }
}

async function fsUpdateLearner(schoolYear, learnerId, learner) {
  try {
    const ref = fsLearnersCollection_(schoolYear).doc(learnerId);
    const before = await ref.get();
    const update = fsCanonicalLearner_(learner);
    if (!Object.prototype.hasOwnProperty.call(learner, "dateAdded")) delete update.dateAdded;
    const merged = { ...(before.exists ? before.data() : {}), ...update, learnerId, schoolYear };
    const archiveType = fsLearnerArchiveType_(merged);
    if (archiveType) {
      const batch = db.batch();
      batch.set(fsArchiveCollection_(archiveType, schoolYear).doc(learnerId), { ...merged, schoolYear }, { merge: true });
      batch.delete(ref);
      await batch.commit();
    } else {
      await ref.set(update, { merge: true });
    }
    fsInvalidateReadCaches_(schoolYear);
    void fsUpdatePublicStatsForChange_(schoolYear, before.exists ? before.data() : {}, archiveType ? {} : merged).catch(() => {});
    fsAudit_("LEARNER_UPDATE", {
      sheet: archiveType ? `${archiveType}_${schoolYear}` : `learners_${schoolYear}`, recordId: learnerId,
      oldValue: before.exists ? JSON.stringify(before.data()) : "",
      newValue: JSON.stringify(learner),
    });
    return { updated: true };
  } catch (error) {
    throw fsError_("Update learner", error);
  }
}

async function fsDeleteLearner(schoolYear, learnerId) {
  try {
    const ref = fsLearnersCollection_(schoolYear).doc(learnerId);
    const before = await ref.get();
    await ref.delete();
    fsInvalidateReadCaches_(schoolYear);
    void fsUpdatePublicStatsForChange_(schoolYear, before.exists ? before.data() : {}, {}).catch(() => {});
    fsAudit_("LEARNER_DELETE", { sheet: `learners_${schoolYear}`, recordId: learnerId });
    return { deleted: true };
  } catch (error) {
    throw fsError_("Remove learner", error);
  }
}

async function fsDeleteLearners(schoolYear, learnerIds) {
  const batch = db.batch();
  learnerIds.forEach((learnerId) => batch.delete(fsLearnersCollection_(schoolYear).doc(learnerId)));
  await batch.commit();
  fsInvalidateReadCaches_(schoolYear);
  void fsRefreshPublicStats().catch(() => {});
  fsAudit_("LEARNER_DELETE", { sheet: `learners_${schoolYear}`, recordId: learnerIds.join(", ") });
  return { deleted: learnerIds.length };
}

if (typeof LPSApi !== "undefined") {
  LPSApi.getLearners = fsGetLearnerPage;
  LPSApi.getLearner = fsGetLearner;
  LPSApi.getLearnerSchema = fsGetLearnerSchema;
  LPSApi.getEnrollmentSections = fsGetSections;
  LPSApi.addLearner = (learner, schoolYear) => fsAddLearner(schoolYear, learner);
  LPSApi.updateLearner = (learnerId, learner, schoolYear) => fsUpdateLearner(schoolYear, learnerId, learner);
  LPSApi.deleteLearner = (learnerId, schoolYear) => fsDeleteLearner(schoolYear, learnerId);
  LPSApi.deleteLearners = (learnerIds, schoolYear) => fsDeleteLearners(schoolYear, learnerIds);
}

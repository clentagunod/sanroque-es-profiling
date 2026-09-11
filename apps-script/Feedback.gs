/**
 * San Roque Website Feedback backend.
 *
 * Bind this script to the separate spreadsheet named
 * "San_Roque_Website_Feedback". Deploy it as a Web App executing as the
 * spreadsheet owner. The website sends a Firebase ID token; this script
 * verifies the token before writing the response.
 */

const FIREBASE_WEB_API_KEY = "AIzaSyCKpafPoWflnjIhZryiOhykKgpF1sMG8-_-_ZoOuAVpIChR9KhNxmtnSNMysst7GIjwavClZ";
const FEEDBACK_SHEET_NAME = "Feedback";
const FEEDBACK_HEADERS = [
  "Date",
  "Email",
  "Ease of Use",
  "User Interface",
  "Navigation",
  "Speed/Performance",
  "Accuracy of Information",
  "Usefulness",
  "Overall Satisfaction",
  "Feedback",
];

function doGet() {
  return jsonOutput_({ ok: true, data: { service: "feedback", status: "ready" } });
}

function doPost(event) {
  try {
    const body = JSON.parse(event.postData.contents || "{}");
    if (body.action !== "submitFeedback") throw new Error("Unknown feedback action.");
    const user = verifyToken_(body.token);
    const payload = validateFeedback_(body);
    const sheet = ensureFeedbackSheet_();
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error("The feedback service is busy. Please try again.");
    try {
      sheet.appendRow([
        new Date(),
        user.email,
        payload.easeOfUse,
        payload.userInterface,
        payload.navigation,
        payload.speedPerformance,
        payload.accuracyInformation,
        payload.usefulness,
        payload.overallSatisfaction,
        payload.feedback,
      ]);
    } finally {
      lock.releaseLock();
    }
    return jsonOutput_({ ok: true, data: { saved: true } });
  } catch (error) {
    return jsonOutput_({ ok: false, error: error.message || "Unable to save feedback." });
  }
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function ensureFeedbackSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(FEEDBACK_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(FEEDBACK_SHEET_NAME);
  const currentHeaders = sheet.getRange(1, 1, 1, FEEDBACK_HEADERS.length).getValues()[0].map(String);
  const matches = FEEDBACK_HEADERS.every((header, index) => currentHeaders[index].trim() === header);
  if (!matches) {
    sheet.getRange(1, 1, 1, FEEDBACK_HEADERS.length).setValues([FEEDBACK_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, FEEDBACK_HEADERS.length).setFontWeight("bold");
  }
  return sheet;
}

function validateFeedback_(body) {
  const ratingFields = [
    "easeOfUse", "userInterface", "navigation", "speedPerformance",
    "accuracyInformation", "usefulness", "overallSatisfaction",
  ];
  const result = {};
  ratingFields.forEach((field) => {
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error("Please provide a rating from 1 to 5 for every category.");
    }
    result[field] = value;
  });
  const feedback = String(body.feedback || "").trim();
  if (!feedback) throw new Error("Written feedback is required.");
  if (feedback.length > 2000) throw new Error("Feedback must be 2,000 characters or fewer.");
  result.feedback = feedback;
  return result;
}

function verifyToken_(idToken) {
  if (!idToken) throw new Error("Missing authentication token.");
  const response = UrlFetchApp.fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_API_KEY,
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ idToken: idToken }),
      muteHttpExceptions: true,
    }
  );
  const result = JSON.parse(response.getContentText() || "{}");
  if (response.getResponseCode() !== 200 || !result.users || !result.users.length || !result.users[0].email) {
    throw new Error("Your session has expired. Please sign in again.");
  }
  return { email: result.users[0].email };
}

/** Run once manually if you want to create and format the Feedback tab before deployment. */
function setupFeedbackSheet() {
  ensureFeedbackSheet_();
  return "Feedback sheet is ready.";
}

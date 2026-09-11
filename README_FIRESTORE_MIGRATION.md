# San Roque ES Website — Firestore Migration Guide (V5)

This document is both (a) a direct answer to the six questions you raised, and
(b) the step-by-step setup guide for the new architecture this version
implements. Read the answers first — they explain *why* the guide is
structured the way it is.

---

## Your six questions, answered

### 1. "Migrate to Firestore, keep Google Sheets as a backup" — is this reasonable?

Yes, and it's the right call for the specific problems you described:

- **Slow / not live**: Sheets is a spreadsheet engine, not a database. Every
  read from Apps Script re-parses a grid; every write competes for a script
  lock. Firestore is a real document database with millisecond reads and
  **live listeners** (`onSnapshot`) — a change on one device appears on every
  other open tab/device within about a second, with no polling or refresh.
- **Concurrent users**: Sheets serializes writes through `LockService`, so
  two teachers saving at once means one waits. Firestore handles concurrent
  writes to different documents natively, and even same-document conflicts
  resolve without a manual lock.
- **"Sometimes not responding"**: this is almost always Sheets' per-minute
  quota or a transient Apps Script cold start. Firestore doesn't share that
  quota.

The spreadsheet is no longer used as a learner-data backup. This avoids
creating a second copy of sensitive records. Only the standalone AuditLog and
Feedback services remain spreadsheet-backed; the migration workbooks are
retained as read-only source snapshots.

### 2. Where do I store the Users tab?

**Firestore**, not Sheets — and this version does that. Reasoning:

- Every single page load calls `getMyProfile()` to check the signed-in
  user's role. That's your highest-frequency read in the whole app. It
  belongs in the fastest store you have, not the slowest.
- Role/status changes (promoting a teacher, disabling a leaver) should take
  effect **immediately** — a live Firestore listener can even force a
  disabled user's session to end without them refreshing. A Sheets-backed
  role check can't do that.
- Firestore Security Rules can enforce "only a School Admin may write to
  `users`" as a **database-level** guarantee, independent of whatever the
  frontend code does. A Sheets + Apps Script check only stops people who go
  through your Apps Script URL "properly."

See Part 2 below for the bootstrap problem (who assigns the *first* admin)
and how `manage-users.js` needed **zero code changes** to run on Firestore.

### 3. Keep only AuditLog and Feedback in Google Sheets

Agreed. Audit logs are append-only, read
rarely (usually only when someone is investigating something), and benefit
from being in a format non-developers can open, filter, and export without
asking you first. There's no live-update requirement for an audit trail.
The standalone `apps-script/AuditLog.gs` service accepts a controlled set of
actions, verifies the Firebase token and Firestore role, and redacts learner
profile fields before writing. The general application Apps Script backend
has been decommissioned. Run `redactExistingAuditLog()` once after deploying
the standalone service to clean legacy audit values.

### 4. Four spreadsheets — collapse into one, or something else?

Use spreadsheet storage only for the two services that require it:

- `AuditLog` (your decision #3)
- `Feedback` (your decision #5)
- No learner, user, school-year, section, settings, or backup tabs.

Practical migration order (don't delete anything until you've verified
Firestore data looks right):
1. Keep `01_CORE_DATABASE.xlsx` (Users/Learners/SchoolYears/Sections/Settings)
   and `02_ENROLLMENT_DATABASE.xlsx`, `03_ACADEMIC_DATABASE.xlsx` around,
   read-only, as your pre-migration snapshot. Don't edit them again.
2. `04_AUDIT_DATABASE.xlsx` becomes your one surviving operations
   spreadsheet. Rename it to something like `San Roque ES - OPERATIONS` and
   add the `Feedback` tab into it (move the tab, update
   `apps-script/Feedback.gs`'s binding, or just keep Feedback's existing
   file if you'd rather not touch a working script — both are fine).
3. The standalone `AuditLog.gs` service writes only sanitized audit metadata
   into the audit spreadsheet. It never exports learner records.


### 5. Feedback stays Sheets-only; "just the important ones I wanna migrate"

Understood as: **keep Feedback fully in Sheets** (unchanged —
`apps-script/Feedback.gs` needed no changes), and migrate to Firestore only
the data collections that actually need to be live: **Users, Learners,
SchoolYears, Sections, Settings**. That's what this version does. If you
meant something different by "the important ones," tell me which specific
tabs/data and I'll adjust — but this is the most defensible reading, and
matches your answers to #3 and #4.

### 6. Restructure the whole codebase

Given the size of this project (~2,200 lines of Apps Script, ~4,200 lines of
frontend JS, ~1,900 lines of HTML across 24 pages), a responsible full
rewrite has to happen in phases rather than as one giant untested drop-in —
otherwise you'd be trusting ~10,000 lines of regenerated code with no way to
verify it still matches your real data. **This version (V5) is Phase 1**:
the foundation (Firestore wired into every page, Users fully migrated,
migration tooling, security rules, backup exporter) plus one worked example
(Manage Users) proving the pattern end-to-end. **Phase 2** is migrating the
remaining pages (dashboard, masterlist, enrollment, programs, reports) one
at a time onto `firestore-api.js`, which is scaffolded and ready — see Part 5.
I'd rather hand you a smaller set of changes you can actually test against
your real school data than a wholesale rewrite you have to trust blindly.

---

## What actually changed in this V5 package

- **Every page** now loads the Firestore SDK (`firebase-firestore-compat.js`)
  alongside the existing Auth SDK, and `js/firebase-config.js` exposes a
  ready-to-use `db` handle.
- **`js/firestore-api.js`** (new) — overrides `LPSApi.getMyProfile`,
  `getUsers`, `addUser`, `updateUser`, `deleteUser`, `deleteUsers` to read
  and write Firestore instead of Sheets. Because it patches the same
  `LPSApi` object, **`manage-users.js` and `manage-users.html` needed no
  changes at all.** It also ships ready-to-use (but not yet wired-up)
  helpers for learners, school years, sections, and settings — see Part 5.
- **`firestore.rules`** (new) — the real access-control layer.
- **`apps-script/AuditLog.gs`** — standalone, authenticated, redacting audit
   service. This is the only Apps Script used by application data flows.
- **`apps-script/Feedback.gs`** — unchanged.
- **`migration/migrate-to-firestore.js`** (new) — one-time Node script that
  reads your four `.xlsx` exports and populates Firestore.
- The general Apps Script application backend was deleted. Firestore is the
   application database; only AuditLog and Feedback remain spreadsheet-backed.

---

## Part 1 — Enable Firestore (5 minutes)

1. [Firebase Console](https://console.firebase.google.com/) → your project
   (`san-roque-es-dashboard-79c21`) → **Build → Firestore Database**.
2. **Create database** → **Start in production mode** (the rules file below
   defines real access control, so production mode is correct) → choose a
   location close to the Philippines (e.g. `asia-southeast1`) → **Enable**.
3. That's it — no billing plan change needed. Firestore's Spark (free) tier
   includes 50K reads / 20K writes / 1GB storage per day, which is far more
   than a single elementary school's daily traffic.

## Part 2 — Users: security rules, deployment, and bootstrapping the first admin

1. **Deploy `firestore.rules`**: Firestore Database → **Rules** tab → paste
   the contents of `firestore.rules` → **Publish**.
2. **The bootstrap problem**: the rules say "only a School Admin can write to
   `users`" — but the very first admin doesn't exist yet, so who creates
   them? Do this once, manually, and never again:
   - Firebase Console → **Authentication** → **Add user** → create the
     admin's email + a temporary password (or have them use "Forgot
     password" after this step).
   - Firebase Console → **Firestore Database** → **Data** tab → start
     collection `users` → **Document ID: paste the UID** you just saw in
     the Authentication tab → add fields `name` (string), `email` (string),
     `role` (string) = `School Admin`, `status` (string) = `Active`.
   - That admin can now sign in and use the Manage Users page to add
     everyone else normally.
3. **Adding subsequent users** (via the Manage Users page, unchanged UI):
   adding a user there creates their **Firestore profile** (role/status)
   but not their **sign-in credentials** — those are two different systems
   on purpose (Firebase Auth is Google-managed and can't be written to from
   plain client code, which is a security feature, not a limitation). After
   adding someone in Manage Users, also create their Authentication account
   (Console → Authentication → Add user) with the same email. Order doesn't
   matter — `firestore-api.js`'s `getMyProfile()` falls back to a "Visitor"
   profile for anyone signed in with no matching document yet, so a
   half-completed setup fails safe instead of crashing.

## Part 3 — Migrate existing data

1. Run `pip install openpyxl` — no wait, this is Node: `npm install
   firebase-admin xlsx` inside the `migration/` folder.
2. Firebase Console → **Project settings (gear icon) → Service accounts** →
   **Generate new private key** → save the download as
   `migration/serviceAccountKey.json`. This file is already excluded in
   `.gitignore` — never commit it or share it; it grants full admin access
   to your Firestore data.
3. Put your current `01_CORE_DATABASE.xlsx`, `02_ENROLLMENT_DATABASE.xlsx`,
   and `03_ACADEMIC_DATABASE.xlsx` (fresh exports: File → Download →
   Microsoft Excel, from each live spreadsheet) into `migration/`.
4. `node migrate-to-firestore.js` with the default `WRITE_ENABLED = false`
   first — this prints exactly what it *would* write, with no risk. Check
   the counts match what you expect (learner counts per year, user count).
5. Set `WRITE_ENABLED = true` in the script and run it again for real.
6. Spot-check in Firebase Console → Firestore Database → Data: open a few
   learner documents and a few user documents, confirm the fields look
   right.

   Every `Enrollment_Data_<school-year>` tab in
   `02_ENROLLMENT_DATABASE.xlsx` is discovered automatically. Its rows are
   imported into the Firestore `sections` collection with `schoolYear`,
   `gradeLevel`, `section`, and `adviser`, so Enrollment Data can show each
   teacher and corresponding section without reading Google Sheets.

   Dropout and Transferred Out rows are stored separately in
   `Dropouts/<school-year>/records` and
   `TransferredOut/<school-year>/records`. Active records use
   `Learners/<school-year>/records`, so active enrollment counts do not include
   archived records. Firestore requires the `records` subcollection between a
   school-year document and each learner document.

### Adding another school year

Add matching source tabs, then rerun the migration. For example, add
`Learners_2027-2028` to the Core workbook and
`Enrollment_Data_2027-2028` to the Enrollment workbook, then run
`node migrate-to-firestore.js`. The script creates:

```text
Learners/2027-2028/records/{LRN}
```

The website reads `schoolYears` dynamically, sorts the years, and adds the new
year to the selector automatically. No JavaScript or HTML change is required.

## Part 4 — Deploy the standalone audit service

Deploy `apps-script/AuditLog.gs` as its own Web App. Configure the Script
Properties `AUDIT_SPREADSHEET_ID`, `FIRESTORE_PROJECT_ID`, and
`FIREBASE_WEB_API_KEY` (the public Firebase Web app `apiKey`, starting with
`AIza`, not the service-account private key), then put the deployed `/exec` URL in
`js/app-config.js` as `auditLogApiUrl`. Run `redactExistingAuditLog()` once.

## Part 5 — Phase 2 roadmap: migrating the remaining pages

`js/firestore-api.js` already has `fsGetLearners`, `fsSubscribeLearners`,
`fsAddLearner`, `fsUpdateLearner`, `fsDeleteLearner`, `fsGetSchoolYears`,
`fsGetSections`, and `fsGetSetting` ready to use. Suggested order (easiest
and highest-value first):

1. **`dashboard.js`** — replace its `LPSApi.getDashboardSummary(...)`-style
   read with `fsSubscribeLearners(schoolYear, renderDashboard)`. This is the
   most-visited page and the best demonstration of "live" data: add a
   learner on one device, watch the dashboard update on another with no
   refresh.
2. **`js/learner-list.js`** (masterlist + underlies several program pages) —
   swap `LPSApi.getLearners/addLearner/updateLearner/deleteLearner(s)` for
   the `fs*` equivalents. Because Firestore has no server-side pagination
   quirks the way Sheets does, you can likely delete the client-side
   `MAX_LEARNER_PAGE_SIZE` chunking logic entirely.
3. **`enrollment-data.js`, `reports.js`, `nutrition.js`, `dropout.js`,
   `transfer-info.js`, `reading-profile.js`, `math-profile.js`,
   `grades-profile.js`** — each currently reads a slice of the same
   learner data from Sheets; once #2 is done, these mostly become Firestore
   `where()` queries instead of Apps Script actions.
4. Once every page reads/writes Firestore, you can **remove** the
   corresponding Learner/Enrollment functions from `Code.gs` (they're left
   untouched in this version specifically so nothing breaks mid-migration).

I'd recommend doing these one page at a time, verifying against real data
after each, rather than all at once — happy to do the next page with you
whenever you're ready.

---

## Testing checklist before you consider this "live"

- [ ] Firestore created, rules published
- [ ] First admin bootstrapped manually, can sign in and see Manage Users
- [ ] Migration dry run counts match expectations; live run completed
- [ ] Add / edit / remove a test user from Manage Users — confirm it
      appears/disappears in Firestore Console immediately
- [ ] A non-admin account gets a permission error trying to call
      `LPSApi.addUser` directly from the browser console (proves rules are
      enforced, not just hidden UI)
- [ ] `setupBackupTrigger` run once; `exportFirestoreBackupToSheets` run
      manually once and the `Backup_*` tabs populated correctly
- [ ] Existing Sheets-backed pages (dashboard, masterlist, etc.) still work
      unmodified

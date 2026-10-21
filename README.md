<p align="center">
  <img width="720" height="720" alt="logo" src="https://github.com/user-attachments/assets/bfb87ae8-ca28-44df-a837-0ddf4a16cea9" />
</p>

# AWS CLF-C02 Simulator

A personal, local tool for practicing questions for the AWS Certified Cloud Practitioner exam. The simulator uses HTML, CSS, plain JavaScript, and JSON; the local Express backend persists progress and exposes the question bank API.

## How to Run

### Electron App

To run the desktop version in development mode:

```powershell
npm install
npm run electron:dev
```

To build the Windows NSIS installer:

```powershell
npm run dist:win
```

The installer and a portable validation build are generated in `release/`. The package includes the frontend, backend, and production dependencies; Node.js and Python are not required on the user's computer.

In the installed version, the distributed catalog seed is empty (`distribution/questions.json`), so personal questions are not bundled into the installer. Local questions, progress, history, the Error Bank, settings, and backups are stored in Electron's user data directory (`app.getPath('userData')`) and are not removed by the standard uninstaller. The development catalog (`data/questions.json`) is not included in the package.

### Updates Through GitHub Releases

The packaged version checks for updates only after starting normally and never downloads an update without confirmation. The provider is configured for the public repository `AdrianCotrim/AWS_CLF-C02_Simulator`. No update checks are performed in development mode.

To publish a release:

1. Update the `version` field in `package.json` using a semantic version, for example `1.0.1`.
2. Update the release notes.
3. Run `npm install` and `npm run dist:win`.
4. Create a matching tag, for example `v1.0.1`.
5. Create a GitHub Release for that tag.
6. Attach the generated installer `.exe`, `.blockmap` file, and `latest.yml` from `release/`.
7. Test update detection from the previously installed version in a VM.

The `latest.yml` file and installer must remain available in the release. The app displays the available version and release notes, asks before downloading, shows progress in the window title, and asks before installing and restarting. If the network or GitHub is unavailable, the installed version continues to work.

Updates replace only application files. Data in `app.getPath('userData')` is not migrated, reset, or overwritten by the updater. The installer is not configured with a digital signature, so SmartScreen warnings may appear.

On Windows, start the backend and frontend together with:

```powershell
.\start-app.bat
```

The launcher reuses this project's servers if they are already running and opens `http://localhost:8000` in Brave, if installed. Otherwise, it opens the default browser.

Browsers block `fetch` requests to local files when `index.html` is opened by double-clicking it (`file://`). Therefore, serve the folder using a simple static server:

```bash
cd aws-simulado
python -m http.server 8000
```

Then visit <http://localhost:8000>. No internet connection is required. Any static server will work (`npx serve`, the VS Code Live Server extension, etc.). To persist progress and use the question creation form, also keep the local API running (see instructions below).

## Modes

- **All**: questions from the bank in random order.
- **New Questions**: only questions you have never answered.
- **Error Bank**: questions answered incorrectly (or marked as “Got it right by guessing”). Answering a question correctly in this mode removes it from the bank.
- **Practice Exam**: configurable number of questions (60 by default), a **Previous** button, an elapsed-time timer, and a final result showing the time taken. Optionally, enable **Time Limit** and enter a duration in minutes (initial suggestion: 90). When time runs out, the exam is submitted automatically and the result indicates that it ended because the time limit expired. The remaining time is recovered correctly if you refresh the page. Without a time limit, the timer continues to count upward.

## How to Add Questions

The approved catalog is stored in `data/questions.json`. Questions created through the **Add Question** screen are saved separately in `data/questions.local.json`, without rewriting the catalog. The backend generates `local-NNN` IDs, and the new question is added to the simulator without reloading the page. When creating a question, select **Add to Error Bank** to also add a reference to it there.

When a new question is saved, the app compares its prompt with existing records after normalizing spaces, line breaks, HTML, and uppercase/lowercase. If matches are found, it lets you cancel, view each matching question, or confirm **Add Anyway**. The check runs only when the form is submitted and does not change the saved text.

When viewing a question in **Question Bank**, use **Add to Error Bank** or **Remove from Error Bank** to change its status at any time. The Error Bank is saved in persisted progress and references questions by ID; question data is not copied. Deleting a question does not delete progress or history associated with its ID.

## Statistics

The **Statistics** section calculates answers, correct answers, incorrect answers, unique questions, daily progress, topics, and sources from `history`. New answers store the date, topic, and source in their own records; older answers without these fields use the question's current data if the question still exists. Practice exam history and recovery of questions from the Error Bank are counted from records with sufficient information, without retroactively inferring complete sessions. Completed practice exams also store elapsed time and whether they ended normally or because the time limit expired; older records without this information remain valid and display the time as unavailable.

```json
{
  "id": "personal-001",
  "source": "Personal",
  "tag": "Cloud Concepts",
  "question": "What is cloud computing?",
  "options": [
    "Back up stored files...",
    "Deploy connected applications...",
    "Run code without the need...",
    "On-demand delivery..."
  ],
  "correct_answer": "On-demand delivery...",
  "explanation": "..."
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | Yes | Unique and stable. Progress is linked to it; do not reuse IDs. |
| `source` | No | Origin (Personal, AWS Official, ExamTopics, etc.). |
| `tag` | No | Question category/topic. |
| `question` | Yes | Question text. |
| `options` | Yes | Array of strings containing the answer choices, or an object such as `{ "A": "..." }` in legacy formats. |
| `correct_answer` | Yes | Exact text of the correct choice, or an array of letters in legacy formats. |
| `explanation` | No | Displayed only if present. |

The app accepts the current `questions.json` format and the older format using `type`, `options` as an object, and `correct_answer` as an array. Invalid questions (duplicate ID, missing text, missing choices, or incompatible `correct_answer`) are ignored and listed in a warning at the top of the page. The remaining questions continue to work.

For `multiple_choice`, an answer is correct only when the selected set matches the `correct_answer` set, regardless of order.

## Organized Persistence

The application stores data in local JSON files, separated by responsibility:

- `data/questions.json`: main question bank used in development; not included in the distribution.
- `distribution/questions.json`: catalog seed included in the packaged app; remains empty for new installations.
- `data/questions.local.json`: locally created, edited, and deleted questions, kept separate from the standard catalog.
- `data/user-data.json`: personal questions, Error Bank IDs, and user preferences. The format includes a data version to facilitate future migrations.
- `data/history.json`: attempt history, results, and other fields used for statistics.

The current 763 questions have been approved as the baseline for separating future changes; this does not mean they are the original catalog or restore any previously missing questions. Edits and deletions of catalog questions are recorded locally as overrides and soft deletions. The catalog report identifies new, changed, removed, and conflicting questions. An edited question can be restored to the current default version from the Question Bank screen. Local files and backups are not distributed with the project.

File access goes through centralized backend modules (`backend/src/data`), preventing each screen or component from writing directly to disk. The local API continues to accept the current question formats and preserves the simulator's existing behavior.

## Progress Persistence and Migration

The simulator's active progress is persisted by the backend in `data/progress.json` as a versioned JSON document. It contains state compatible with the frontend: data by `questionId`, answer history, the Error Bank, and a resumable practice exam session. Each save is serialized, written using atomic replacement, and read back for verification. The footer indicates when progress is being saved.

On the first run after this update, the app checks the legacy LocalStorage key `clf-c02-progress`. If data is found, it displays a summary and asks for confirmation before migrating it. If backend progress already exists, replacing it requires explicit confirmation; separate backups of the current and legacy states are created in `data/backups/` beforehand. The migration validates the structure and session references, verifies the write, and only then reports success. Legacy LocalStorage is not deleted and receives no further writes. If the data is invalid or migration fails, an error is reported and the original remains intact.

LocalStorage is consulted only during this assisted migration. Therefore, old data may still exist separately for each browser and address (`localhost:8000` and `localhost:5500` have separate storage), but it is no longer the active source of progress.

## Progress Backup

- **Export Progress** downloads a JSON file (`version`, `exportedAt`, `statistics`, `questionProgress`, `errorBank`, `history`).
- **Import Progress** first creates a safety backup in the backend and, after confirmation, replaces the persisted state; the active session is not imported.
- **Delete Progress** removes the current state from `data/progress.json` after confirmation; `questions.json` is not affected. Legacy LocalStorage is not removed.

Make regular backups and keep copies outside the project folder.

## Full Backup and Restore

Use **Create Full Backup** to download a versioned JSON file containing the effective questions, default catalog, local changes, ID sequence, `user-data.json`, `history.json`, and persisted progress. Progress includes `questionProgress`, answer history, and any practice exam session currently in progress.

Use **Validate and Restore Backup** to select a full backup file. The application validates the format, version, structure, and checksums before displaying a summary and asking for confirmation. The current format uses `format: "aws-clf-c02-backup"` and `version: 2`; legacy `version: 1` backups are still accepted and restored as a baseline catalog, without retroactive source classification. SHA-256 checksums detect accidental corruption; they do not authenticate the file or prove that its contents are trustworthy.

Before replacing data, the backend creates a safety backup of the current JSON files, including persisted progress, in `data/backups/`. Files are prepared as temporary files and replaced individually; if a replacement fails, the backend attempts to roll back files already replaced. After restoration, the frontend uses the progress restored by the backend.

Restoring multiple files is not a single transaction: an abrupt process termination or a failure during rollback may still require manual recovery using the safety backup. Also keep the downloaded backup in another location. The API requires the current `questions.json`, `user-data.json`, and `history.json` files to create the backup and safety copy; if any is missing or corrupted, the operation is rejected rather than silently replacing it with empty values. The sequence file may be missing, in which case the next ID is derived from the highest current ID.

The full backup does not include `node_modules`, caches, or logs, and it does not modify the official persistence source. The backend continues to read and write the current JSON paths. The `data/backups/` directory is the appropriate location for the current local project; in a future Electron distribution, backups and other writable data should be moved to the application's user data directory. The backend server listens only on `127.0.0.1`, without exposing the API to external network interfaces.

## Local Question API

In development, the simulator loads the initial bank from `data/questions.json`; in the packaged app, it loads the empty seed from `distribution/questions.json`. The question creation screen uses the local API. To install and start the API, use Node.js 18 or later:

```bash
cd backend
npm install
npm run server
```

The API is available at `http://127.0.0.1:3000`; the port can be changed using the `PORT` environment variable. Storage remains in `data/questions.json` at the project root. The backend does not create the file automatically: if it is missing, the API returns an error and does not replace the bank.

Available endpoints:

- `GET /api/progress`: reads persisted state and reports whether it exists.
- `PUT /api/progress`: validates and saves a complete progress snapshot.
- `POST /api/progress/migration/preview`: validates legacy progress and returns summaries of LocalStorage and backend data.
- `POST /api/progress/migration`: migrates legacy progress. Use `replaceExisting: true` only after explicit confirmation to replace existing progress; the route creates backups before writing.
- `POST /api/progress/import`: imports a validated state after creating a safety backup.
- `POST /api/backup/create`: creates a versioned backup using persisted progress.
- `POST /api/backup/validate`: validates a submitted full bundle in `{ backup: ... }` without writing data.
- `POST /api/backup/restore`: restores a validated bundle submitted in `{ backup: ..., currentProgress: ... }`. First creates a safety copy of current data.
- `GET /api/questions`: returns the effective list composed of the default catalog and local changes.
- `GET /api/questions/catalog-status`: reports catalog updates and conflicts with local changes; `POST /api/questions/catalog-status/acknowledge` records that the report has been reviewed.
- `GET /api/questions/:id/metadata`: indicates whether a question belongs to the catalog or is local.
- `POST /api/questions/:id/restore-default`: removes the local edit and restores the current default version.
- `GET /api/questions/:id`: returns a question or HTTP 404.
- `POST /api/questions`: validates and adds a question, returning HTTP 201. The server generates the `local-NNN` ID; do not send `id`.
- `POST /api/questions/import`: previews or confirms a bulk import. Send `{ questions: [...] }` and use `confirm: true` only for final confirmation. The route returns a summary of valid, duplicate, and invalid items before writing any data.
- `PUT /api/questions/:id`: validates and updates question fields without changing the ID; returns HTTP 404 if the question does not exist.
- `DELETE /api/questions/:id`: deletes a local question or records a soft deletion of a default question; returns its ID and responds with HTTP 404 if it does not exist.

Example question for creation (the `correct_answer` field can be the answer choice's letter or its text):

```json
{
  "source": "Personal",
  "tag": "Cloud Concepts",
  "question": "What is another name for an on-premises deployment?",
  "options": ["Private cloud", "Cloud-based application", "Hybrid deployment", "AWS Cloud"],
  "correct_answer": "A",
  "explanation": "An on-premises deployment is also called a private cloud deployment."
}
```

Test the endpoints in PowerShell while the server is running:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/questions
Invoke-RestMethod http://127.0.0.1:3000/api/questions/personal-001
$body = @{ source = 'Personal'; tag = 'Cloud Concepts'; question = 'Updated question prompt?'; options = @('Choice A', 'Choice B'); correct_answer = 'A'; explanation = '' } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:3000/api/questions/personal-001 -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Delete -Uri http://127.0.0.1:3000/api/questions/personal-001
$body = @{ source = 'Personal'; tag = 'Cloud Concepts'; question = 'Example question?'; options = @('Choice A', 'Choice B'); correct_answer = 'A'; explanation = 'Choice A is correct.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/questions -ContentType 'application/json' -Body $body
```

To run the automated API tests, execute `npm test` inside `backend/`.

In the simulator, **Question Bank** loads the current list through the API and lets you search by text, Source, and Tag; filter questions that are in or out of the **Error Bank**; and open each question's details. When entering this section, the data is refreshed from the backend.

POST requests modify the persistent JSON file. Invalid data returns HTTP 400 in JSON; read/write errors or corrupted files return HTTP 500. CORS allows local origins on `localhost` and `127.0.0.1` during development.

DELETE requests require confirmation in the interface. For default questions, deletion is logical and can be reversed if the question appears in the catalog again; local questions are removed from local changes. An auxiliary sequence preserves the highest number already issued so the backend does not reuse old IDs.

## Implementation Decisions

- Statistics count each question once, based on the result of its most recent answer (so correct + incorrect = answered).
- Outside Practice Exam mode, a session goes through the filtered and shuffled set once and shows the result at the end. Only Practice Exam sessions are persisted.
- Answer choices are not shuffled in this version.
- Error-reason categories (section 17) have not been implemented; only “Got it right by guessing” is available.

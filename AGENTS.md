# AGENTS.md

Guidance for AI coding agents working in this repository. Read it fully before changing code.

## 1. Project Overview & Architecture

**KeepX** is a local, offline-capable archive for X/Twitter posts. A Chrome/Brave extension saves posts from x.com, a Node.js backend stores them in SQLite plus media files on disk, and a web dashboard lets the user search, tag, and browse the archive.

There is no build step, no bundler, and no framework. It is plain CommonJS on the backend, vanilla JS in the extension and dashboard, and Tailwind via CDN.

### Layout

```
backend/
  server.js        Express app setup: middleware, static hosting, router mounting, startup
  config.js        PORT, MEDIA_DIR, FRONTEND_DIR, optional Telegram settings
  db.js            SQLite (sqlite3) access: schema, migrations, queries, FTS index
  routes/
    tweets.js      /api/tweets: save, list, tags, delete
    import.js      /api/import: input validation, calls the import service
    backup.js      /api/backup: JSONL database export and import (without media files)
  services/
    media.js       Media download/save/removal (collectMedia, removeMediaFiles)
    importer.js    fxtwitter import (importTweets)
    telegram.js    Telegram Bot API polling and channel tweet-link detection
    links.js       Normalize and deduplicate tweet links before storage
  tests/
    telegram.test.js Telegram integration unit tests (mock API)
  package.json     Backend dependencies and the `start` script
  storage/media/   Downloaded images/videos (git-ignored, user data)
  tweets.db*       SQLite database and WAL files (user data, NOT git-ignored yet)
extension/
  manifest.json    Manifest V3 (host permissions for x.com, twitter.com, localhost:3000)
  content.js       Runs on x.com: injects the save button, parses the tweet DOM, records videos
  background.js    Service worker: forwards SAVE_TWEET messages to the backend via fetch (owns the API URL)
  content.css      Button styling
frontend/
  index.html       Dashboard markup (Tailwind CDN)
  app.js           Dashboard logic; talks to the backend via relative paths (/api, /media)
README.md          Project overview, setup, and usage documentation (German)
```

### Entry points

- Backend: `backend/server.js` (listens on `PORT`, default `3000`).
- Dashboard: served by the backend at `http://localhost:3000/` from `frontend/index.html`.
- Extension: `content.js` (page context) and `background.js` (service worker).

### Data flow

```
x.com tweet --content.js--> chrome.runtime.sendMessage(SAVE_TWEET)
            --background.js--> POST /api/tweets --server.js--> downloads media -> storage/media
                                                           \--> db.js -> tweets.db
Dashboard --GET /api/tweets?limit&cursor&q&tag--> paged tweets + media + links + tags
Dashboard Import dialog --POST /api/import--> api.fxtwitter.com -> same save path
Telegram channel --Bot API polling--> tweet links --> same fxtwitter import path
```

### REST API (routes in `backend/routes/`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/tweets` | Save a tweet from the extension (`media_urls` and/or `media_assets`) |
| POST | `/api/import` | Import 1..50 tweet URLs via fxtwitter; already stored tweets are skipped |
| GET | `/api/tweets` | Paged list. Query: `q`, `tag`, `limit` (default 30, max 500), `cursor`. Returns `{ tweets, next_cursor, tags }` (`tags` only without `cursor`) |
| POST | `/api/tweets/:id/tags` | Add a tag (`{ tag }`) |
| DELETE | `/api/tweets/:id/tags/:tag` | Remove a tag |
| PUT | `/api/tweets/:id/notes` | Save personal notes (`{ notes }`) |
| DELETE | `/api/tweets/:id` | Delete tweet and its media files |
| GET | `/api/backup/export` | Export database records (`tweets`, `tags`, `tweet_links`, `media` metadata, `telegram_state`) as `.jsonl` |
| POST | `/api/backup/import` | Import database records from `.jsonl` (`{ jsonl }` or raw text); existing tweets are skipped |
| GET | `/health` | Liveness check |
| static | `/media/*`, `/` | Media files, dashboard |

### Database (`backend/db.js`)

Tables: `tweets` (including optional personal `notes`), `media`, `tweet_links`, `tags` (name UNIQUE), `tweet_tags` (composite PK), plus the FTS5 virtual table `tweets_fts`.

- Tweet links are normalized, filtered, and deduplicated at save time; reads return stored links as-is.
- `tweets_fts` is an external-content FTS5 index over `tweets.text`, `tweets.notes`, `tweets.author_name`, and `tweets.author_handle`, with the `trigram` tokenizer. It is kept in sync by the triggers `tweets_fts_ai/ad/au`. `initDb()` drops and rebuilds it if it does not match the current schema.
- Search terms of 3+ characters use FTS (`MATCH`), shorter terms fall back to `LIKE`.
- Sort order is `datetime(COALESCE(created_at, saved_at)) DESC, id DESC`. The pagination cursor is `"<sort_key>|<id>"`. `SORT_KEY_SQL` must match the expression index `idx_tweets_sort`.
- Media rows store only the file name in `local_path` (files are named `<tweetId>_<n><ext>` and served at `/media/<file>`).
- `telegram_state` stores the most recently processed Telegram update ID so polling resumes safely after a restart.

## 2. Environment & Core Commands

**Prerequisites:** Node.js (developed on Node 24), npm, Windows with PowerShell 5.1. Chrome or Brave for the extension. Internet access is needed for the Tailwind CDN, the fxtwitter import, and media downloads. The optional Telegram integration also needs access to the Telegram Bot API.

| Task | Command |
| --- | --- |
| Install dependencies | `npm --prefix backend install` |
| Run backend | `npm --prefix backend start` |
| Run backend tests | `npm --prefix backend test` |
| Change port | `$env:PORT=3001; npm --prefix backend start` (the extension hardcodes port 3000 in `background.js` and `manifest.json`, so update those too; the dashboard uses relative paths) |
| Health check | `Invoke-RestMethod http://localhost:3000/health` |
| Syntax check | `node --check backend/server.js` and `node --check backend/db.js` (also the files in `backend/routes` and `backend/services`) |
| Build | none |
| Tests | backend unit tests use Node's built-in test runner |
| Lint / format | none configured |

There is no file watcher. After changes:
- Backend: stop and restart the server.
- Dashboard: hard-reload the page (Ctrl+F5).
- Extension: reload it at `chrome://extensions` (or `brave://extensions`), then refresh the x.com tab.

### Optional Telegram import

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` in the backend process environment before starting the server. The channel ID can be its numeric Telegram ID (for example, `-1001234567890`) or its public username prefixed with `@`. Do not put the bot token in source files or logs.

Create a bot with BotFather, add it to the channel, and ensure it can receive channel posts. The backend uses Telegram Bot API long polling; remove any configured webhook for the bot before enabling this integration. Only new channel posts are scanned, and only direct X/Twitter status links are imported. Existing posts are not backfilled. Failed imports are retried, and successfully processed update progress persists in the existing SQLite database. If either environment variable is missing, Telegram polling stays disabled and the manual dashboard import continues to work.

For a PowerShell session, set the variables before starting the backend:

```powershell
$env:TELEGRAM_BOT_TOKEN = "your-bot-token"
$env:TELEGRAM_CHANNEL_ID = "-1001234567890"
npm --prefix backend start
```

Alternatively, run `.\start-telegram.ps1` from the repository root. Enter the bot token and channel ID directly in the two variables at the top of the script; it is excluded from Git by `.gitignore`, so never remove it from there. Unset either variable to disable Telegram polling for that process. The first startup after this change creates the non-destructive `telegram_state` table in the existing database.

### Shell notes (PowerShell 5.1)

- Chain commands with `;`, never `&&`.
- Quoting for `node -e` is fragile. Wrap the script in single quotes and use backtick template strings inside it (no embedded double or single quotes), for example `node -e 'const d=require(`./backend/db`); ...'`. Run it from the repository root.
- To stop a server you cannot see, find the PID with `Get-NetTCPConnection -LocalPort 3000 -State Listen` and use `Stop-Process`.

## 3. Code Style & Architectural Guidelines

Match the existing style:

- **Language:** CommonJS on the backend (`require`, `module.exports`), no TypeScript, no ES modules. No JSDoc or type annotations are used.
- **Formatting:** 2-space indent, double quotes, semicolons, trailing-comma-free object literals.
- **Naming:** `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants. Database columns and JSON payload fields are `snake_case` (`author_name`, `media_urls`, `next_cursor`). Keep this across the API boundary.
- **Language of text:** Identifiers are English. User-visible UI strings and code comments are German (ASCII, no umlauts in the UI strings, for example "loeschen", "oeffnen"). Keep that.
- **Comments:** Only where the code cannot explain itself, one short line.
- **Async:** Use `async/await`. In `db.js` use the promise wrappers `run`, `get`, `all`, `exec`. Do not mix in callbacks.
- **SQL:** Always parameterize user input. The only interpolated fragments are constants (`SORT_KEY_SQL`) and generated `?` placeholder lists. Schema changes go in `initDb()` with `IF NOT EXISTS`, and need an explicit migration step if existing data is affected (see the FTS handling).
- **Error handling:** Routes wrap work in `try/catch` and answer with a status code and `{ error, details? }`. Failures of single media downloads are logged with `console.warn` and must not abort saving the tweet.
- **Dashboard:** Build DOM with `createElement` and `textContent`. Never put tweet data into `innerHTML`. Use Tailwind utility classes, no custom CSS unless necessary. Load data through paging (`loadTweets`, `loadMoreTweets`) and lazy loading (`IntersectionObserver` for images and videos). Keep the logic in `frontend/app.js`, not inline in `index.html`.
- **Backend structure:** `server.js` only wires things together. HTTP handling belongs in `routes/`, everything else (downloads, import, file handling) in `services/`. Keep MIME/extension handling on the server; the extension must not send file extensions.
- **Extension:** Only use stable `data-testid` selectors. The content script talks to the backend through the service worker (`SAVE_TWEET` message), not directly. The API URL lives only in `background.js`.

## 4. Agent Workflow & Best Practices

- Read the relevant files before editing. Keep diffs small and focused. Do not reformat or refactor unrelated code.
- After editing JS or HTML, check for errors (editor diagnostics or `node --check`).
- Verify database changes against the real code path, but note that `db.js` opens `backend/tweets.db` with a hardcoded path. `initDb()` modifies the schema, so prefer a copy of the database for experiments. If you add tests, make the DB path configurable (for example via an environment variable) and use `node --test` with a temporary database.
- For new backend behavior, add tests when a test setup exists. Until then, state clearly how you verified the change.
- When you change a REST endpoint, response shape, port, or message format, update all consumers in the same change: the route or service in `backend/`, `frontend/app.js`, `extension/content.js`, `extension/background.js`, and `manifest.json` host permissions.
- Tell the user which restarts or reloads are needed (backend, extension, dashboard).
- Do not create extra Markdown or documentation files unless asked. Update this file when commands, structure, or conventions change.
- Do not commit, push, or run destructive git commands unless asked.

## 5. Constraints & Safeguards

### Ask before touching

- `backend/tweets.db`, `tweets.db-shm`, `tweets.db-wal`, and everything in `backend/storage/`. This is the user's archive. Never delete, reset, or rewrite it, and do not commit it.
- Destructive schema changes (dropping or renaming tables or columns) and anything that rewrites stored data.
- `extension/manifest.json` permissions and host permissions.

### Do not

- Switch back to `better-sqlite3`. It failed to build on Node 24 on this Windows setup (no prebuilt binary, no Windows SDK). The project uses `sqlite3`.
- Bind the server to more interfaces, widen CORS, or add routes that fetch arbitrary URLs. See the known issues below.
- Add external network dependencies to the dashboard beyond the existing Tailwind CDN and fxtwitter import, because the project is meant to work offline.
- Change the search tokenizer or the `tweets.text` / `tweets_fts` columns without updating the triggers and the migration in `initDb()`.
- Send the same media through both `media_urls` and `media_assets`. This already caused duplicated images. Images go in `media_urls`, captured or blob videos go in `media_assets`.
- Load all tweets at once or add per-tweet queries (N+1) to `getTweets`. Keep paging and the batched `IN (...)` queries.
- Rely on brittle X DOM structure (first `a[href*="/status/"]`, first `a[href^="/"]`). It breaks on quoted tweets and replies. Prefer scoped selectors.

### Known issues (do not make worse, fix only when asked)

- The server listens on all interfaces and uses `cors()` with no restrictions, so any web page or host on the network can call the API.
- `downloadMediaFile` (in `services/media.js`) downloads any URL it is given (SSRF risk). A host allowlist (`pbs.twimg.com`, `video.twimg.com`) is the intended fix.
- `saveTweetWithMedia` serializes transactions via a write queue on the shared connection and cleans up orphaned media files when overwriting a tweet.
- Deleting a tweet removes its media files before the database row.
- Tags are always stored lowercase. `addTagToTweet` and `removeTagFromTweet` lowercase the name, and `initDb()` runs `lowercaseExistingTags()`, which renames old tags and merges case variants (keeping all tweet assignments). Orphaned tags without tweets are automatically removed.
- `express.json({ limit: "100mb" })` applies to every route because videos are sent as Base64.
- Video saving in the extension resolves direct MP4 URLs on the server via `api.fxtwitter.com` first, falling back to browser-side `MediaRecorder` capture only if server-side resolution returns no video (for example on protected accounts).
- Image URLs from `pbs.twimg.com/media/` are upgraded to `name=orig` so full-resolution images are stored.
- Links are normalized and deduplicated when saving. Existing database entries are not rewritten.
- `.gitignore` excludes `backend/storage/`, `backend/logs/`, `backend/node_modules/`, `backend/tweets.db*`, and `start-telegram.ps1` (already-tracked files in Git remain tracked until removed from the index with `git rm --cached`).
- There is no linter or configuration for the port in the extension.

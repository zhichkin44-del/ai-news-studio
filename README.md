# Studio News

An automated pipeline for a Russian-language world-news channel: it collects news from about 100 feeds, groups items into events, scores them, prepares posts for an AI editor, and publishes approved posts to Telegram.

The channel content is in Russian. The code, docs and CLI are in English.

## Features

- **Feed collection** from 92 RSS/Atom feeds and a USGS earthquake GeoJSON feed, plus 6 "hype" signal sources (Reddit, Wikipedia, Bluesky, Google Trends). Items are stored in SQLite (`node:sqlite`, WAL mode).
- **Event grouping and scoring**: items are clustered into events, scored by independent source count and freshness, and checked against a diversity policy (for example, politics is capped per day's top).
- **Editorial hand-off**: `npm run batch` writes an event pack for an AI editor; `npm run ingest` loads the editor's posts, runs them through a content gate (no links, no outlet names) and stores them as drafts. Historical anniversaries ("65 years ago") are filtered out during selection.
- **Telegram publishing module** (`src/publish.js`): HTML formatting for the Bot API, a queue with hourly and minimum-gap limits, retries and duplicate protection. Posts are published only after owner approval. The HTTP sender is injected by the caller; no bot token is stored in this repository.
- **Infographic cards**: 1080×1350 PNG cards rendered from HTML with headless Chrome or Edge, with a channel watermark. If no browser is found, posts are sent as text.
- **Operations**: `npm run digest` builds a night/morning digest, `npm run smoke` checks that feeds are alive, and `npm run metrics` reports collection and selection statistics.

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite` module). Tested with Node.js 24.22.1 on Windows 11.
- **Operating systems**: developed and tested on Windows 11. CI runs the install steps and tests on Ubuntu and Windows. macOS is not tested.
- **Internet access** for live collection (`npm run radar`, `npm run smoke`). No API keys are needed for collection.
- **Optional**: Google Chrome or Microsoft Edge, for rendering infographic cards. No GPU is needed.
- **No npm dependencies.** There is nothing to install beyond Node.js.

## Installation

### Windows (PowerShell)

```powershell
# 1. Install Node.js 22 or newer from https://nodejs.org, then check the version:
node --version

# 2. Get the code
git clone https://github.com/zhichkin44-del/studio-news.git
cd studio-news

# 3. Run the tests
npm test
```

### macOS and Linux (bash)

```bash
# 1. Install Node.js 22 or newer (for example with nvm: nvm install 22), then check:
node --version

# 2. Get the code
git clone https://github.com/zhichkin44-del/studio-news.git
cd studio-news

# 3. Run the tests
npm test
```

Expected result: `ℹ pass 270`, `ℹ fail 0`.

## Configuration

Copy the example file and edit it if you want to change paths:

```bash
cp .env.example .env
```

```powershell
Copy-Item .env.example .env
```

The variables in `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `NEWS_DB` | `data/news.db` | SQLite database file. |
| `NEWS_BATCHES` | `data/batches` | Folder where event packs for the editor are written. |
| `NEWS_IMAGES_DIR` | `data/images` | Folder for downloaded post images. |
| `CARD_BROWSER` | (auto-detected) | Full path to `chrome.exe` or `msedge.exe` for card rendering. Leave empty to auto-detect. |
| `ISSUE_N` | `30` | Number of events in an issue (`npm run issue`). |

The code reads these variables from the process environment. It does not load `.env` automatically, so set them in your shell before running a command:

```powershell
$env:NEWS_DB = "C:\news-data\news.db"
```

```bash
export NEWS_DB=/home/me/news-data/news.db
```

No secrets are required by this repository. Telegram credentials, if you use the publisher, belong to the code that calls `src/publish.js`, not to this repository.

## Usage

The pipeline runs in this order. Each step is a separate command.

1. **Collect** items from all feeds (one pass, then exit):

   ```bash
   npm run radar -- --once
   ```

   Output: one line per pass with the number of new items and the number of feeds with errors. Data goes to `data/news.db`.

2. **Check feeds** (live request, does not write to the database):

   ```bash
   npm run smoke
   ```

   Prints a table of feeds with their newest item age. Exit code 0 means all feeds are fresh.

3. **Select events** from the last 24 hours (or `--hours N`):

   ```bash
   npm run select
   ```

   Output: counts of items, events, selected, rejected and top-of-day events.

4. **Create an event pack for the editor**, then load the editor's posts:

   ```bash
   npm run batch -- --max 12
   npm run ingest -- data/batches/<pack-folder>
   npm run drafts
   ```

   The editor is an AI agent outside this repository that writes posts following `docs/methodology/`. `ingest` expects a `posts.json` file in the pack folder, with items `{id, style, text}`.

5. **Check posts** without touching the database:

   ```bash
   npm run check-posts -- path/to/posts.json
   ```

Other commands: `npm run issue` (Markdown issue of top events, written to `out/`), `npm run digest` (night digest, default window 18:00–08:00 UTC+7), `npm run metrics -- --hours 72`, `npm run images`.

## Tests

```bash
npm test
```

Runs the `node:test` suites in `test/` (270 tests, all passing on 2026-11-21, Windows 11, Node.js 24.22.1). The test files use fixtures in `test/fixtures/`; they make no network calls.

GitHub Actions runs the same install steps and tests on `ubuntu-latest` and `windows-latest` (see `.github/workflows/install-check.yml`).

## Project structure

```
src/             pipeline modules: collect, cluster, score, select, batch, ingest, gate,
                 publish, card (infographics), watermark, store (SQLite), metrics
src/hype/        hype-signal sources: Reddit, Wikipedia, Bluesky, Google Trends
test/            node:test suites (270 tests) and fixtures
sources.json     feed list (92 RSS/Atom, 6 hype sources)
docs/            charter, interface notes, acceptance criteria, editorial methodology
data/, out/      generated at runtime, git-ignored
```

## Documentation

The project charter, interface notes, acceptance criteria and editorial methodology are in `docs/`. They are currently written in Russian.

## License

MIT. See [LICENSE](LICENSE).

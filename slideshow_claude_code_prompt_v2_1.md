# Claude Code prompt — Home photo/video slideshow server (cross-platform)

You are building a self-hosted slideshow application that runs on an Intel NUC and renders on an LG WebOS smart TV via the TV's built-in browser. The server must run on **both Windows 11 and Ubuntu 22.04+** from a single codebase. The application logic is OS-agnostic; only the install scripts and service wrappers differ.

Implement the project end-to-end in a single repository. Do not stop until acceptance criteria pass for at least one OS (Windows 11 is the immediate target; Linux paths must be present and reviewed but full Linux verification is deferred).

---

## 1. Mission

A media server that:

1. Reads photos and videos from a user-selected root folder on an external HDD. The folder is structured `YYYY/MM/*` (20 year folders, 12 month folders inside each, ~400 GB total).
2. Plays them fullscreen on a TV browser pointed at `http://<nuc-ip>:8080/slideshow`.
3. Supports two modes: **sequential** (recurse through folders in order) and **random** (weighted by file count per folder, using a prefix-sum array).
4. Pre-caches the next item so transitions have no visible lag.
5. Accepts WebOS Magic Remote inputs (next, prev, volume up, volume down, pause).
6. Displays current folder path (`2014/06`) bottom-left and live clock bottom-right.
7. Can be started and stopped with one double-click on Windows or one `systemctl` command on Linux.
8. Lets the user pick the media root folder via a setup web page (so the path isn't hardcoded).

## 2. Environment

Two supported targets. The application code must be identical between them.

**Windows 11 (primary target):**
- Node.js 20 LTS installed via MSI or winget.
- ffmpeg installed via `winget install ffmpeg` or scoop.
- NSSM (Non-Sucking Service Manager) for service wrapping.
- External HDD as a drive letter, e.g. `E:\Photos`.

**Ubuntu 22.04 / 24.04 LTS (future migration target):**
- Node.js 20 LTS from NodeSource.
- ffmpeg from apt.
- systemd for service wrapping.
- External HDD mounted via fstab, e.g. `/mnt/photos`.

LAN only. No authentication required for v1, but stub a `BASIC_AUTH` env var that, if set, enables HTTP basic auth on all routes. Bind to `0.0.0.0:8080`.

## 3. Tech stack (exact)

- **Runtime:** Node.js 20 LTS.
- **HTTP:** Express 4.
- **WebSocket:** `ws`.
- **Image utilities:** `sharp` (HEIC -> JPEG transcoding only).
- **Video probing:** `fluent-ffmpeg` (optional, only if needed; otherwise rely on browser `ended` event).
- **MIME:** `mime-types`.
- **Path/config portability:** `env-paths`.
- **No build step** for the frontend: vanilla HTML/CSS/JS. The WebOS browser is Chromium-87-based — stick to ES2019 features, no top-level await.

## 4. Repository layout

```
slideshow/
├── package.json
├── README.md
├── .env.example
├── src/                            # 100% portable Node code
│   ├── server.js
│   ├── config.js
│   ├── paths.js                    # wraps env-paths, the only OS branch in src/
│   ├── indexer.js
│   ├── prefixSum.js
│   ├── selector.js
│   ├── cache.js
│   ├── state.js
│   ├── ws.js
│   └── routes/
│       ├── admin.js
│       └── stream.js
├── public/                         # 100% portable frontend
│   ├── index.html                  # setup landing page
│   ├── slideshow.html              # TV-facing fullscreen page
│   ├── styles.css
│   ├── app.js
│   └── remote.js
├── platform/
│   ├── windows/
│   │   ├── install.ps1             # downloads NSSM, registers service
│   │   ├── uninstall.ps1
│   │   ├── start.bat
│   │   ├── stop.bat
│   │   └── status.bat
│   └── linux/
│       ├── install.sh              # sets up systemd unit
│       ├── uninstall.sh
│       ├── slideshow.service.tmpl
│       └── README-fstab.md
└── tests/
    ├── prefixSum.test.js
    ├── selector.test.js
    ├── stream.range.test.js
    └── paths.test.js
```

## 5. Portability rules (mandatory)

These are non-negotiable. Violating any of them is a defect.

1. **Never hardcode path separators.** Always `path.join()`, `path.sep`, `path.resolve()`. Never the literal `/` or `\\` in any code path that touches disk.
2. **Never shell out** to OS-specific commands from inside `src/`. No `child_process.exec("ls ...")`, no `dir`, no `find`, no `mount`. Use Node's `fs.promises` APIs. The only allowed exception is `fluent-ffmpeg`, which abstracts the ffmpeg binary across OSes.
3. **Config and state directories** come from `env-paths("slideshow")`. Never write to `~/.slideshow/` or `%APPDATA%\slideshow\` directly. See section 5.1 below.
4. **Signal handling must cover all three signals:** `SIGTERM`, `SIGINT`, `SIGBREAK` (Windows NSSM stop sends `CTRL_BREAK_EVENT` -> `SIGBREAK`). Same shutdown handler attached to all three.
5. **Line endings.** Repo uses `.gitattributes` with `* text=auto eol=lf` so platform-specific scripts retain correct endings (`.sh` -> LF, `.ps1`/`.bat` -> CRLF). Add the file.
6. **Drive letters and UNC paths are valid.** When validating a user-supplied media root, do not assume it begins with `/`. `E:\Photos`, `\\server\share\Photos`, and `/mnt/photos` must all be accepted.
7. **No bash assumptions inside Node.** No backticks, no `&&` chained commands, no env-var expansion via the shell.

### 5.1 The paths module (`src/paths.js`)

The only file in `src/` that knows about OS conventions. Wraps `env-paths`:

```js
import envPaths from "env-paths";
import path from "node:path";
import fs from "node:fs";

const ep = envPaths("slideshow", { suffix: "" });

export const paths = {
  config: ep.config,       // Windows: %APPDATA%\slideshow
                           // Linux:   ~/.config/slideshow
                           // macOS:   ~/Library/Preferences/slideshow
  data:   ep.data,         // index.json and state.json live here
  cache:  ep.cache,        // optional: transcoded HEIC cache to disk
  log:    ep.log,
};

export function ensureDirs() {
  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const configFile = path.join(paths.config, "config.json");
export const indexFile  = path.join(paths.data,   "index.json");
export const stateFile  = path.join(paths.data,   "state.json");
```

Call `ensureDirs()` on server startup before any read/write to these locations.

Cover `paths.test.js` with a test that asserts every exported path is absolute and that `ensureDirs()` is idempotent.

## 6. Module specs

### 6.1 Indexer (`src/indexer.js`)

- Input: absolute root path. Validate it exists and is readable using `fs.promises.access`. Reject UNC paths only if the user explicitly disables them via env var; otherwise allow.
- Walk: depth = 2. Top level entries must match `^\d{4}$`; second level must match `^(0[1-9]|1[0-2])$`. Anything else is logged and ignored.
- For each `YYYY/MM` folder, list files with extensions:
  - Images: `.jpg .jpeg .png .gif .webp .heic .heif .bmp`
  - Videos: `.mp4 .mov .m4v .mkv .webm .avi`
- Skip dotfiles (filenames starting with `.`), skip zero-byte files, skip symlinks (`fs.Dirent.isSymbolicLink()`).
- Sort files within each folder by filename ascending using `Intl.Collator("en", { numeric: true })` so `IMG_2.jpg` precedes `IMG_10.jpg`.
- Produce:
  ```js
  {
    root: "E:\\Photos",         // or "/mnt/photos" on Linux
    builtAt: 1716000000,
    folders: [{ rel: "2014/06", files: ["IMG_001.jpg", "IMG_002.jpg"], count: 2 }, ...],
    counts: [2, ...],
    prefix: [2, ...],
    total: <int>
  }
  ```
  Note `rel` always uses forward slashes regardless of OS, because it is a logical identifier exposed in URLs. Convert to OS-native separators only when constructing on-disk paths via `path.join(root, ...rel.split("/"))`.
- Persist atomically to `indexFile` (write tmp file, `fs.promises.rename`). On Windows, rename across same volume is atomic; if the tmp file is on a different volume, fall back to copy-then-unlink.
- Concurrency: cap `readdir` at 8 in flight; emit progress events every 100 folders.
- Do not auto-watch the filesystem. Rescan only on `POST /api/reindex`.

### 6.2 Prefix sum (`src/prefixSum.js`)

Pure module, no I/O.

```js
buildPrefix(counts) -> number[]
findFolderIndex(prefix, r) -> number   // binary search
```

Unit tests: empty array throws; single-folder; equal-count folders; heavily skewed.

### 6.3 Selector (`src/selector.js`)

```js
nextSequential(state)
prevSequential(state)
pickRandom(state)
prevRandom(state)
```

`state.history` is a bounded deque of size 50.

Statistical test: 10 000 random picks, empirical frequency per folder within +/- 2% of expected weight.

### 6.4 Cache (`src/cache.js`)

LRU keyed by absolute path. Default 512 MB budget; `CACHE_BYTES` env override.

- Images and transcoded HEIC outputs: full buffer.
- Videos: do NOT buffer the whole file. `prefetch(path)` opens the file, reads the first 16 MB to prime the OS page cache, closes. This works on both Windows and Linux — the OS-level page cache exists on both.
- Strict LRU eviction.

### 6.5 State (`src/state.js`)

```js
{
  mode: "sequential" | "random",
  imgSec: 5,
  cursor: { folderIdx, fileIdx },
  history: [...],
  current: { rel, file, kind, url, durationSec? } | null,
  volume: 0.8,
  paused: false,
  connectedClients: 0
}
```

Persisted to `stateFile` on graceful shutdown. Reloaded on boot.

### 6.6 Stream route (`src/routes/stream.js`)

`GET /media?folder=2014/06&file=IMG_001.jpg`

- Resolve final path: `const target = path.resolve(root, ...folder.split("/"), file);`
- Path-traversal check: ensure `target` starts with `path.resolve(root) + path.sep`. Use `path.sep`, never a hardcoded character.
- 404 if file does not exist.
- For `.heic` / `.heif`: transcode with `sharp(...).jpeg({ quality: 85 })`, serve as `image/jpeg`, cache the buffer.
- Images: full body, `Cache-Control: public, max-age=86400`, ETag = hash of `size + mtime`.
- Videos: support HTTP Range. Parse `bytes=start-end`, return 206 with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`. Default chunk size 1 MB if no end given.
- Range parsing tests: malformed -> 416; start past EOF -> 416; open-ended -> serves to EOF.

### 6.7 WebSocket (`src/ws.js`)

Endpoint: `ws://host:8080/ctrl`.

Server -> client messages: `show`, `volume`, `paused`, `mode`, `status`, `error`.

Client -> server messages: `ready`, `ended`, `remote { key }`, `config { imgSec?, mode? }`.

After every state transition, broadcast `show` including `nextHint` (the URL and kind of the upcoming item) so the frontend can preload.

Ping/pong every 15 s. Drop clients that miss two pongs.

### 6.8 Admin (`src/routes/admin.js`)

- `GET /` — if no `mediaRoot` configured, render `public/index.html`; otherwise redirect to `/slideshow`.
- `GET /api/dirs?path=<abs>` — list immediate subdirectories of `path`, filter hidden. Allow listing from `os.homedir()`, from any drive root on Windows (`C:\`, `D:\`, `E:\`, ...), and from `/mnt`, `/media`, `/home` on Linux. Reject parent-traversal attempts.
- `GET /api/drives` (Windows only, no-op on Linux) — enumerate available drive letters by attempting `fs.promises.access` on `A:\` through `Z:\`. Used to populate the root dropdown of the folder picker.
- `POST /api/root` `{ path }` — validate exists and readable; save to config; trigger index build.
- `POST /api/reindex` — async rescan, returns 202.
- `GET /api/status` — `{ indexed, total, mode, imgSec, root, indexingProgress?: 0..1 }`.
- `GET /slideshow` — serves `public/slideshow.html`.

### 6.9 Frontend slideshow (`public/slideshow.html`, `app.js`)

Black background, hidden cursor. Two stacked layers for crossfade. Bottom-left `#folder`, bottom-right `#clock` updating every second. Top-center `#toast` for volume/mode changes.

- On WS `show`: build new media element in inactive layer; on `load`/`loadeddata` swap opacity (200ms transition); update `#folder`; warm `nextHint` in a hidden preloader.
- On image: client-side `setTimeout(imgSec * 1000)` -> send `{type:"ended"}`.
- On video: `ended` event -> send `{type:"ended"}`. `error` event -> send `{type:"ended"}` after 500ms fallback so a corrupt file doesn't stall.
- Reconnect WS with exponential backoff capped at 10 s.

### 6.10 Frontend remote (`public/remote.js`)

`window.addEventListener("keydown")`. Map:

| Key | Action |
|---|---|
| ArrowRight (39) | next |
| ArrowLeft (37) | prev |
| ArrowUp (38) | volUp |
| ArrowDown (40) | volDown |
| Enter (13, OK) | pause |
| WebOS Back (461) | prev |
| WebOS Play (415) | pause |
| WebOS Pause (19) | pause |
| R (82) | shuffleToggle |

`event.preventDefault()`, send `{type:"remote", key:"..."}`. Debounce per-key at 150 ms.

### 6.11 Server entry (`src/server.js`)

```js
import { ensureDirs } from "./paths.js";

// ... imports ...

ensureDirs();
const cfg = loadConfig();

const httpServer = http.createServer(app);
attachWs(httpServer);

httpServer.listen(cfg.port, "0.0.0.0", () => {
  log.info({ port: cfg.port }, "slideshow listening");
});

const shutdown = async (signal) => {
  log.info({ signal }, "shutting down");
  httpServer.close();
  await state.persist();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));   // Linux systemd
process.on("SIGINT",  () => shutdown("SIGINT"));    // Ctrl+C
process.on("SIGBREAK", () => shutdown("SIGBREAK")); // Windows NSSM stop
```

## 7. Platform install layer

### 7.1 Windows (`platform/windows/install.ps1`)

Run from an **Administrator PowerShell**:

```powershell
# Pseudo-spec for install.ps1
1. Check Node 20+ installed; if not, instruct user to install via winget and exit.
2. Check ffmpeg in PATH; if not, instruct user to `winget install ffmpeg` and exit.
3. Set $InstallDir = "C:\slideshow" (or %ProgramFiles%\slideshow if preferred).
4. Copy repo contents to $InstallDir (skip platform/linux, node_modules, .git).
5. cd $InstallDir; npm ci --omit=dev
6. Download NSSM from https://nssm.cc/release/nssm-2.24.zip if not present in $InstallDir\bin\nssm.exe.
7. Register service:
     nssm install Slideshow "$env:ProgramFiles\nodejs\node.exe" "$InstallDir\src\server.js"
     nssm set Slideshow AppDirectory $InstallDir
     nssm set Slideshow AppStdout "$InstallDir\logs\stdout.log"
     nssm set Slideshow AppStderr "$InstallDir\logs\stderr.log"
     nssm set Slideshow AppRotateFiles 1
     nssm set Slideshow AppRotateBytes 10485760
     nssm set Slideshow Start SERVICE_DEMAND_START   # manual start, NOT auto on boot
     nssm set Slideshow AppExit Default Restart
     nssm set Slideshow AppRestartDelay 3000
8. Print next steps: how to start/stop, the URL for the setup page, the URL for the TV.
```

`start.bat` (double-clickable):

```bat
@echo off
nssm start Slideshow
echo Slideshow started. Open http://localhost:8080/ to configure.
pause
```

`stop.bat`:

```bat
@echo off
nssm stop Slideshow
echo Slideshow stopped.
pause
```

`status.bat`:

```bat
@echo off
sc query Slideshow
pause
```

`uninstall.ps1`: stops the service, removes it via `nssm remove Slideshow confirm`, prints a note that config in `%APPDATA%\slideshow` is preserved unless deleted manually.

### 7.2 Linux (`platform/linux/install.sh`)

Run with `sudo bash platform/linux/install.sh`:

```bash
# Pseudo-spec for install.sh
1. Refuse if not Linux (uname -s != Linux).
2. apt-get update && apt-get install -y ffmpeg
3. If node --version is missing or < v20, install via NodeSource setup script.
4. INSTALL_DIR=/opt/slideshow; mkdir -p; copy repo (skip platform/windows, node_modules, .git).
5. chown -R $SUDO_USER:$SUDO_USER $INSTALL_DIR
6. sudo -u $SUDO_USER bash -c "cd $INSTALL_DIR && npm ci --omit=dev"
7. Render slideshow.service.tmpl with $SUDO_USER, install to /etc/systemd/system/slideshow.service
8. systemctl daemon-reload
9. Do NOT systemctl enable. Print next steps.
```

`slideshow.service.tmpl`:

```ini
[Unit]
Description=Home Slideshow Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__USER__
WorkingDirectory=/opt/slideshow
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/slideshow/src/server.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`README-fstab.md` explains how to add the external HDD to `/etc/fstab` so it remounts after reboot.

## 8. Configuration

Config file lives at `paths.config + "/config.json"`. Same schema on both OSes:

```json
{
  "mediaRoot": "E:\\Photos",
  "imgSec": 5,
  "mode": "sequential",
  "cacheBytes": 536870912,
  "port": 8080
}
```

Env vars override config: `PORT`, `MEDIA_ROOT`, `CACHE_BYTES`, `IMG_SEC`, `MODE`.

When the user later migrates to Ubuntu, the config file will not exist on the new host. The setup page handles that — they re-pick the media root, which will now be a Linux path. Everything else (port, modes, imgSec) gets re-entered or defaults back in.

## 9. Acceptance criteria

Windows 11 (required for v1):

- [ ] `install.ps1` on a fresh Windows 11 box completes without errors when run as Admin.
- [ ] `start.bat` brings the service up. `status.bat` reports `RUNNING`.
- [ ] Opening `http://localhost:8080/` on first boot shows the setup page with a drive-letter dropdown and folder picker.
- [ ] Picking the media root triggers an index. Indexing 400 GB across 240 folders on USB 3.0 HDD completes in under 5 minutes.
- [ ] Opening `http://<nuc-ip>:8080/slideshow` on the WebOS TV browser shows the first item within 2 s.
- [ ] Sequential mode plays YYYY/MM/filename in ascending order.
- [ ] Random mode passes the +/- 2% statistical test.
- [ ] Image duration configurable via WS `config`. Videos play to natural end.
- [ ] No black frame between items (preload verified via timing log).
- [ ] Arrow keys on a USB keyboard plugged into the NUC produce server-side state changes within 100 ms.
- [ ] HEIC files render correctly.
- [ ] `stop.bat` terminates the process within 5 s. State persists; restart resumes.
- [ ] All unit tests pass: `npm test`.

Linux (deferred verification — code present, scripts present, but full integration not required to declare v1 done):

- [ ] `install.sh` syntax checked with `bash -n`.
- [ ] systemd unit syntax checked with `systemd-analyze verify`.
- [ ] `npm test` passes on Linux (running the test suite is fine on either OS).

## 10. Quality bar

- Strict path-traversal protection using `path.sep`, never hardcoded.
- All disk writes restricted to directories returned by `env-paths` plus the install directory.
- Structured JSON logs to stdout: `{ts, level, msg, ...fields}`. NSSM captures these to rotating log files; journald captures them on Linux.
- Graceful shutdown on `SIGTERM`/`SIGINT`/`SIGBREAK`: stop accepting requests, close WS connections with code 1001, flush state, exit 0, within 5 s.
- JSDoc on every exported function.
- README sections:
  1. What this is
  2. Hardware assumptions
  3. Windows install (the path you will follow first)
  4. Linux install (for future migration)
  5. fstab guidance for the external HDD on Linux
  6. Troubleshooting (port in use, HDD not present, WebOS browser cache, NSSM permission issues, systemd not enabled)
  7. How to back up your config (one file, copy `%APPDATA%\slideshow\config.json` or `~/.config/slideshow/config.json`)

## 11. Stretch (after MVP)

1. Optional HTTP basic auth gated by env var.
2. Phone-as-remote at `/remote` — separate page, same WS endpoint.
3. Per-year filter ("only play 2014-2018").
4. Pin-folder mode (lock random picks to a single year or month).
5. Thumbnail strip on long-press OK.
6. Reverse proxy for HTTPS (Caddy on Linux, IIS or Caddy-for-Windows on Windows).

## 12. Do NOT do any of the following

- Do not hardcode path separators or drive letters anywhere in `src/`.
- Do not shell out to OS-specific commands from inside `src/`.
- Do not introduce a database.
- Do not introduce a frontend framework or bundler.
- Do not buffer entire video files into memory.
- Do not auto-enable the service on boot (neither NSSM `SERVICE_AUTO_START` nor `systemctl enable`).
- Do not write any file outside the directories returned by `env-paths` or the install directory.

---

Begin. Print a short plan first (file list with one-line purposes), then implement top-down: `paths.js` and `indexer.js` and `prefixSum.js` first with tests, then `selector.js` with the statistical test, then HTTP + streaming, then WebSocket, then frontend, then the Windows install path, then the Linux install path. After each module, run its tests and report results before moving on.

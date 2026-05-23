# Slideshow

A self-hosted photo/video slideshow server. The server runs on a small headless
box (Intel NUC, mini PC, Raspberry Pi 5) and renders fullscreen on an LG WebOS
TV via the TV's built-in browser pointed at
`http://<server-ip>:8080/slideshow`. One codebase, two install paths: Windows
11 (NSSM) and Ubuntu 22.04+ (systemd).

## 1. What this is

- Reads a `YYYY/MM/<files>` photo tree off an external HDD (20 year folders, 12
  month folders inside each, ~400 GB tested target).
- Plays everything fullscreen in the TV browser. Crossfade between items, no
  black frame (next item is preloaded).
- Two selection modes:
  - **Sequential** — walk folders in order.
  - **Random** — weighted by file count per folder (so a folder with 5000
    pictures gets played 100× more often than a folder with 50 pictures).
- LG Magic Remote works out of the box: arrows = next/prev, up/down = volume,
  Enter or Play = pause, R = toggle shuffle.
- Bottom-left shows the current folder (`2014/06`); bottom-right shows the
  current time.
- One double-click to start on Windows, one `systemctl start` on Linux.

LAN only. No accounts. If you set the `BASIC_AUTH=user:pass` env var, every
route is gated by HTTP basic auth.

## 2. Hardware assumptions

- Intel NUC class machine (any 64-bit x86 with at least 4 GB RAM and USB 3.0).
- Wired Ethernet to the same LAN as the TV. Wi-Fi will work but is slower for
  large videos.
- External HDD or SSD plugged in over USB 3.0. ext4 / NTFS / exFAT all work.
- LG TV running WebOS 4+ (browser is Chromium 87-ish). Any modern Chromium will
  do; Safari and Firefox also work for diagnostics.

## 3. Windows install (immediate target)

Prereqs (one-time):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
# Reboot or close/reopen PowerShell so the new PATH applies.
```

Install:

```powershell
# Open an *Administrator* PowerShell.
cd <repo-dir>
powershell -ExecutionPolicy Bypass -File .\platform\windows\install.ps1
```

The installer copies the repo to `C:\slideshow`, runs `npm ci`, downloads NSSM,
and registers a manual-start service named `Slideshow`. It does NOT start on
boot — that's by design.

Daily use:

| Action  | Command                                  |
|---------|------------------------------------------|
| Start   | Double-click `C:\slideshow\platform\windows\start.bat` |
| Stop    | Double-click `C:\slideshow\platform\windows\stop.bat`  |
| Status  | Double-click `C:\slideshow\platform\windows\status.bat`|

Then open `http://localhost:8080/` on the same machine to pick the media root.
Once indexing finishes, point the TV browser to
`http://<this-pc-ip>:8080/slideshow`.

Logs: `C:\slideshow\logs\stdout.log` and `stderr.log` (rotated at 10 MB).
Config: `%APPDATA%\slideshow\config.json`.

## 4. Linux install (future migration)

```bash
git clone <this-repo> ~/slideshow-src
cd ~/slideshow-src
sudo bash platform/linux/install.sh
```

Daily use:

```bash
sudo systemctl start slideshow
sudo systemctl stop slideshow
systemctl status slideshow
journalctl -u slideshow -f          # live log tail
```

Then open `http://localhost:8080/` to pick the media root.

Config: `~/.config/slideshow/config.json`.

## 5. fstab guidance for the external HDD on Linux

See `platform/linux/README-fstab.md`. Short version: mount by UUID under
`/mnt/photos` with `nofail` so the box still boots when the drive is unplugged.

## 6. Troubleshooting

**Port 8080 already in use.**
On Windows: `netstat -ano | findstr :8080` shows the PID; kill it or change
`PORT` in the NSSM service properties.
On Linux: `sudo ss -lptn 'sport = :8080'`. To change, edit
`/etc/systemd/system/slideshow.service` (Environment=PORT=...) and
`systemctl daemon-reload && systemctl restart slideshow`.

**HDD not present at boot (Linux).**
The unit waits for `network-online.target`, not for your disk. If the disk is
slow to enumerate, the index will be empty on first start. Either re-mount and
hit `POST /api/reindex` (the setup page exposes a "Reindex" button), or add a
proper `RequiresMountsFor=/mnt/photos` line to the unit if you want hard
startup ordering. The default keeps boot fast even when the drive is missing.

**WebOS browser caching old assets.**
Force-reload: in the LG browser, open the settings menu and "Clear browsing
data" — or rename the bookmark so it loads as a fresh tab. Hard refresh keyboard
shortcut on the Magic Remote: Settings -> Reset.

**NSSM "Access denied" registering the service (Windows).**
You must run the install in an **Administrator** PowerShell. Right-click the
PowerShell icon -> "Run as administrator". If you previously ran it as a
non-admin, the service might be in a half-registered state; run
`platform\windows\uninstall.ps1` as admin first, then reinstall.

**systemd unit "not found" after install (Linux).**
The unit lives at `/etc/systemd/system/slideshow.service`. If
`systemctl status slideshow` says "Unit not found":
`ls -l /etc/systemd/system/slideshow.service` to confirm, then
`sudo systemctl daemon-reload`.

**Random mode picks the same folder over and over.**
That's the weighting — a folder with 5000 files is selected 100× more often
than a folder with 50. Hit `R` on the keyboard to toggle back to sequential, or
add per-year filtering in a follow-up.

**HEIC photos don't load.**
The server transcodes HEIC to JPEG via `sharp`. On first request the buffer is
cached. If the file is malformed, the slideshow advances to the next item
after 500 ms instead of stalling.

**Videos stutter or audio is out of sync.**
The TV browser is the bottleneck for large files. Re-encode the worst
offenders to H.264 (MP4) at a moderate bitrate — `ffmpeg -i in.mov -c:v libx264
-preset slow -crf 20 -c:a aac -b:a 192k out.mp4` — and overwrite the source.

## 7. Back up your config

Single file. Copy it whenever you change anything:

- Windows: `%APPDATA%\slideshow\config.json`
- Linux:   `~/.config/slideshow/config.json`

The index (`index.json` under `paths.data`) is large and rebuildable —
don't bother backing it up.

## Tests

```bash
npm install
npm test
```

Tests cover the prefix-sum math, the random selector's empirical distribution
(±2% on 10 000 picks), HTTP Range parsing (malformed → 416, start past EOF →
416, open-ended → EOF), path-traversal protection, ETag conditional GET, and
the env-paths layout.

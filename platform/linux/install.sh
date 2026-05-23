#!/usr/bin/env bash
# Install the Slideshow server as a systemd unit on Ubuntu 22.04+ / 24.04+.
#
# Run as:   sudo bash platform/linux/install.sh
#
# 1. Refuses to run on non-Linux.
# 2. Installs ffmpeg via apt.
# 3. Installs Node 20 LTS from NodeSource if missing or older.
# 4. Copies the repo to /opt/slideshow (excluding node_modules, .git, platform/windows).
# 5. chown's it to the invoking user so npm ci writes into their cache.
# 6. Runs `npm ci --omit=dev` as that user.
# 7. Renders slideshow.service.tmpl into /etc/systemd/system/slideshow.service.
# 8. Reloads systemd. Does NOT enable the unit (per spec, no boot-start).

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is Linux-only. Use platform/windows/install.ps1 on Windows." >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo (we need to write /opt/slideshow and the systemd unit)." >&2
  exit 1
fi

if [[ -z "${SUDO_USER:-}" || "$SUDO_USER" == "root" ]]; then
  echo "Run via 'sudo', not as root directly: we need a non-root user to own the install." >&2
  exit 1
fi

INSTALL_DIR="${INSTALL_DIR:-/opt/slideshow}"
PORT="${PORT:-8080}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE_USER="$SUDO_USER"

echo "[install] Repo:        $REPO_ROOT"
echo "[install] Install dir: $INSTALL_DIR"
echo "[install] Service user: $SERVICE_USER"

echo "[install] apt-get update + ffmpeg ..."
DEBIAN_FRONTEND=noninteractive apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg curl ca-certificates

# Node 20+
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  CUR=$(node -p 'process.versions.node.split(".")[0]')
  if [[ "$CUR" -lt 20 ]]; then NEED_NODE=1; fi
fi
if [[ "$NEED_NODE" -eq 1 ]]; then
  echo "[install] Installing Node 20 LTS via NodeSource ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

echo "[install] Copying repo to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
# rsync skips node_modules + .git + the Windows scripts to stay portable.
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='platform/windows' \
  --exclude='logs' \
  --exclude='tests' \
  "$REPO_ROOT"/ "$INSTALL_DIR"/

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo "[install] Running npm ci as $SERVICE_USER ..."
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && npm ci --omit=dev"

UNIT_SRC="$INSTALL_DIR/platform/linux/slideshow.service.tmpl"
UNIT_DST="/etc/systemd/system/slideshow.service"
if [[ ! -f "$UNIT_SRC" ]]; then
  echo "Unit template missing at $UNIT_SRC" >&2; exit 1
fi
echo "[install] Rendering systemd unit -> $UNIT_DST"
sed -e "s|__USER__|$SERVICE_USER|g" -e "s|__PORT__|$PORT|g" "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"

systemctl daemon-reload

cat <<EOF

[install] Done.

Next steps:
  - Start:   sudo systemctl start slideshow
  - Stop:    sudo systemctl stop slideshow
  - Status:  systemctl status slideshow
  - Logs:    journalctl -u slideshow -f
  - Setup:   http://localhost:$PORT/
  - TV:      http://<this-host-ip>:$PORT/slideshow
  - fstab:   see $INSTALL_DIR/platform/linux/README-fstab.md

The unit is NOT enabled (no automatic start at boot). Run
'sudo systemctl enable slideshow' if you change your mind later.
EOF

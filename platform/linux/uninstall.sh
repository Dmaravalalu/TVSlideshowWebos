#!/usr/bin/env bash
# Remove the Slideshow systemd unit. Leaves /opt/slideshow and ~/.config/slideshow
# in place so a reinstall picks up the config.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo." >&2; exit 1
fi

systemctl stop slideshow 2>/dev/null || true
systemctl disable slideshow 2>/dev/null || true
rm -f /etc/systemd/system/slideshow.service
systemctl daemon-reload

echo "[uninstall] Unit removed. /opt/slideshow and per-user config preserved."

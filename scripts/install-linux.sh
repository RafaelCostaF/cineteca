#!/usr/bin/env bash
# Adds Cineteca to the application menu (and optionally to autostart) when
# running from a cloned repository. Usage: ./scripts/install-linux.sh [--autostart]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$REPO/node_modules/.bin/electron"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

if [[ ! -x "$ELECTRON" ]]; then
  echo "Run 'npm install' in $REPO first." >&2
  exit 1
fi

mkdir -p "$APPS" "$ICONS"
cp "$REPO/build/icon.png" "$ICONS/cineteca.png"

desktop_entry() {
  cat <<DESKTOP
[Desktop Entry]
Type=Application
Name=Cineteca
Comment=Download, organise and stream movies, series, anime and books
Exec="$ELECTRON" "$REPO" $1
Icon=cineteca
Terminal=false
Categories=AudioVideo;Video;Network;P2P;
StartupWMClass=Cineteca
DESKTOP
}

desktop_entry "" > "$APPS/cineteca.desktop"
echo "Added Cineteca to the application menu."

if [[ "${1:-}" == "--autostart" ]]; then
  AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
  mkdir -p "$AUTOSTART"
  desktop_entry "--hidden" > "$AUTOSTART/cineteca.desktop"
  echo "Cineteca will start hidden in the background when you log in."
fi

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true

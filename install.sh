#!/data/data/com.termux/files/usr/bin/bash
# Bananarama for Android - installer for Termux.
#
#   curl -fsSL https://raw.githubusercontent.com/GunGreenEyes/Bananarama-Android/main/install.sh | bash
#
# Run it again to update. Installs Node.js + Termux:API tools, puts Bananarama in
# ~/bananarama (latest release), sets up start-at-boot, home-screen widgets and the
# share sheet, then asks for your Gemini API key and starts the background service.
set -euo pipefail

REPO="GunGreenEyes/Bananarama-Android"
DIR="${BANANARAMA_DIR:-$HOME/bananarama}"

say() { printf '\033[1;33m🍌 %s\033[0m\n' "$*"; }

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ]; then
  echo "This installer runs inside Termux on Android (get Termux from F-Droid or GitHub, not the Play Store)." >&2
  exit 1
fi

say "Installing packages (nodejs-lts, git, termux-api)…"
pkg update -y >/dev/null || true
pkg install -y nodejs-lts git termux-api curl >/dev/null

if [ ! -d "$HOME/storage" ]; then
  say "Allow storage access so images can go to Pictures/Nano (tap Allow)…"
  termux-setup-storage || true
  for _ in $(seq 1 30); do [ -d "$HOME/storage/pictures" ] && break; sleep 1; done
fi

TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1 || true)
REF="${BANANARAMA_REF:-${TAG:-main}}"
if [ -d "$DIR/.git" ]; then
  say "Updating to $REF…"
  "$DIR/bin/bananarama" stop >/dev/null 2>&1 || true
  git -C "$DIR" fetch --quiet --tags --force origin
  git -C "$DIR" checkout --quiet --force "$REF"
  [ "$REF" = "main" ] && git -C "$DIR" reset --quiet --hard origin/main
else
  say "Downloading Bananarama ($REF)…"
  git clone --quiet "https://github.com/$REPO.git" "$DIR"
  git -C "$DIR" checkout --quiet "$REF"
fi
chmod +x "$DIR/bin/bananarama"

say "Setting up boot, widgets, share sheet and Claude Code skills…"
node "$DIR/src/android/main.js" setup

if ! node -e "process.exit(require('$DIR/src/lib/settings').load().apiKey ? 0 : 1)"; then
  say "Paste your Gemini API key (from aistudio.google.com/apikey) in the dialog…"
  "$DIR/bin/bananarama" settings || true
fi

"$DIR/bin/bananarama" start
say "Done. Look for the Bananarama notification. Try:  bananarama new"
say "Galaxy tip: Settings → Battery → Background usage limits → Never sleeping apps → add Termux."

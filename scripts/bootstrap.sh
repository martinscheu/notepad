#!/usr/bin/env bash
set -euo pipefail

APP_NAME="stickynotes"
BASE_DIR="/opt/${APP_NAME}"

NOTES_DIR="${BASE_DIR}/notes"
RELEASES_DIR="${BASE_DIR}/releases"
CONFIG_DIR="${BASE_DIR}/config"

EXAMPLE_CONFIG_RELATIVE_PATH="config.example/config.json"

log() { echo "[bootstrap] $1"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root (or via sudo)"
    exit 1
  fi
}

require_root

log "Bootstrapping ${APP_NAME} in ${BASE_DIR}"

log "Creating base directories (if missing)"
mkdir -p \
  "${RELEASES_DIR}" \
  "${NOTES_DIR}/notes" \
  "${NOTES_DIR}/trash" \
  "${NOTES_DIR}/exports" \
  "${CONFIG_DIR}"

if [ ! -f "${CONFIG_DIR}/config.json" ]; then
  if [ -f "${EXAMPLE_CONFIG_RELATIVE_PATH}" ]; then
    log "Creating config.json from example"
    cp "${EXAMPLE_CONFIG_RELATIVE_PATH}" "${CONFIG_DIR}/config.json"
  else
    log "No example config found, creating empty config.json"
    echo "{}" > "${CONFIG_DIR}/config.json"
  fi
else
  log "config.json already exists, keeping it"
fi

if [ ! -f "${CONFIG_DIR}/compose.env" ]; then
  log "Creating compose.env with defaults (edit if desired)"
  cat > "${CONFIG_DIR}/compose.env" <<EOF
BIND_ADDR=0.0.0.0
HOST_PORT=8060
EOF
else
  log "compose.env already exists, keeping it"
fi

log "Setting directory permissions"
chmod 750 "${BASE_DIR}"
chmod 750 "${NOTES_DIR}" "${CONFIG_DIR}" "${RELEASES_DIR}"

log "Bootstrap completed successfully"

echo
echo "Next steps:"
echo "  - Upload a release zip"
echo "  - Run: sudo ./scripts/deploy.sh /path/to/stickynotes-<version>.zip"

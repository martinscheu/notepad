#!/usr/bin/env bash
set -euo pipefail

APP_NAME="stickynotes"
BASE_DIR="/opt/${APP_NAME}"

RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
CONFIG_DIR="${BASE_DIR}/config"
NOTES_DIR="${BASE_DIR}/notes"

COMPOSE_REL_PATH="docker/docker-compose.yml"

log() { echo "[deploy] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Run as root (use sudo)."
  fi
}

require_tools() {
  command -v docker >/dev/null 2>&1 || die "docker not found"
  docker compose version >/dev/null 2>&1 || die "docker compose not available (need Docker Compose v2)"
}

ensure_bootstrap_layout() {
  [ -d "${RELEASES_DIR}" ] || die "Missing ${RELEASES_DIR}. Run bootstrap.sh first."
  [ -d "${CONFIG_DIR}" ] || die "Missing ${CONFIG_DIR}. Run bootstrap.sh first."
  [ -d "${NOTES_DIR}/notes" ] || die "Missing ${NOTES_DIR}/notes. Run bootstrap.sh first."
  [ -d "${NOTES_DIR}/trash" ] || die "Missing ${NOTES_DIR}/trash. Run bootstrap.sh first."
  [ -d "${NOTES_DIR}/exports" ] || die "Missing ${NOTES_DIR}/exports. Run bootstrap.sh first."
}

infer_version_from_zip() {
  local zip="$1"
  local base
  base="$(basename "$zip")"
  if [[ "$base" =~ ([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

compose_down_if_possible() {
  local compose_file="$1"
  if [ -f "$compose_file" ]; then
    log "Stopping existing containers (docker compose down)"
    docker compose -f "$compose_file" down || true
  fi
}

main() {
  require_root
  require_tools
  ensure_bootstrap_layout

  local src="${1:-}"
  local version="${2:-}"

  if [ -z "${src}" ]; then
    cat <<EOF
Usage:
  sudo ./scripts/deploy.sh /path/to/stickynotes-0.2.0.zip [version]
  sudo ./scripts/deploy.sh /path/to/stickynotes/ 0.2.0

Examples:
  sudo ./scripts/deploy.sh /tmp/stickynotes-0.2.0.zip
  sudo ./scripts/deploy.sh /tmp/stickynotes.zip 0.2.0
  sudo ./scripts/deploy.sh /home/user/stickynotes 0.2.0
EOF
    exit 1
  fi

  if [ -f "${src}" ]; then
    command -v unzip >/dev/null 2>&1 || die "unzip not found"
    if [ -z "${version}" ]; then
      if version="$(infer_version_from_zip "${src}")"; then
        log "Inferred version: ${version}"
      else
        die "Could not infer version from zip name. Provide version as second argument."
      fi
    fi
  elif [ -d "${src}" ]; then
    [ -n "${version}" ] || die "Version is required when deploying from a directory."
  else
    die "Source not found: ${src}"
  fi

  local release_dir="${RELEASES_DIR}/${version}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  log "Preparing release ${version}"
  log "Temp dir: ${tmp_dir}"
  log "Release dir: ${release_dir}"

  if [ -e "${release_dir}" ]; then
    die "Release directory already exists: ${release_dir} (choose a new version or delete it)"
  fi

  local project_root="${tmp_dir}"
  if [ -f "${src}" ]; then
    log "Unzipping into temp dir"
    unzip -q "${src}" -d "${tmp_dir}"

    if [ -d "${tmp_dir}/${APP_NAME}" ]; then
      project_root="${tmp_dir}/${APP_NAME}"
    else
      local top_dirs
      top_dirs="$(find "${tmp_dir}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
      if [ "${top_dirs}" = "1" ]; then
        project_root="$(find "${tmp_dir}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
      fi
    fi
  else
    log "Copying source directory into temp dir"
    project_root="${tmp_dir}/${APP_NAME}"
    mkdir -p "${project_root}"
    cp -a "${src}/." "${project_root}/"
  fi

  log "Detected project root: ${project_root}"

  local compose_file="${project_root}/${COMPOSE_REL_PATH}"
  [ -f "${compose_file}" ] || die "Compose file not found at expected path: ${compose_file}"

  if [ -L "${CURRENT_LINK}" ] || [ -d "${CURRENT_LINK}" ]; then
    local current_compose="${CURRENT_LINK}/${COMPOSE_REL_PATH}"
    compose_down_if_possible "${current_compose}"
  fi

  log "Moving project into releases directory"
  mkdir -p "${RELEASES_DIR}"
  mv "${project_root}" "${release_dir}"

  log "Updating current symlink"
  local new_link="${CURRENT_LINK}.new"
  ln -sfn "${release_dir}" "${new_link}"
  mv -Tf "${new_link}" "${CURRENT_LINK}"

  local active_compose="${CURRENT_LINK}/${COMPOSE_REL_PATH}"

  log "Rebuilding containers without cache"
  docker compose --env-file "${CONFIG_DIR}/compose.env" -f "${active_compose}" build --no-cache

  log "Starting containers"
  docker compose --env-file "${CONFIG_DIR}/compose.env" -f "${active_compose}" up -d

  log "Deployment complete"
  log "Active release: ${version}"
  log "Current points to: $(readlink -f "${CURRENT_LINK}")"

  rm -rf "${tmp_dir}" || true
}

main "$@"

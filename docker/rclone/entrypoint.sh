#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
NOTES_DIR="${NOTES_DIR:-/data/notes}"
SYNC_DIR="${SYNC_DIR:-/data/sync}"
SETTINGS="${SYNC_DIR}/settings.json"
STATUS="${SYNC_DIR}/status.json"
RUN_ONCE="${SYNC_DIR}/run_once"
RCLONE_CONF="${SYNC_DIR}/rclone.conf"
LOG_DIR="${SYNC_DIR}/logs"
LOG_FILE="${LOG_DIR}/rclone.log"
WORKDIR="${SYNC_DIR}/workdir"

mkdir -p "${SYNC_DIR}" "${LOG_DIR}" "${WORKDIR}"

ts(){ date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log(){
  echo "$(ts) $*" | tee -a "${LOG_FILE}" || true
}

json_escape(){
  # escape backslashes and quotes for JSON strings
  echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_status(){
  result="$1"
  time_now="$(ts)"
  if [ "${result}" = "error" ]; then
    msg="${2:-unknown}"
    esc="$(json_escape "${msg}")"
    cat > "${STATUS}" <<EOF
{"last_result":"error","last_time":"${time_now}","last_error":"${esc}"}
EOF
  else
    cat > "${STATUS}" <<EOF
{"last_result":"${result}","last_time":"${time_now}"}
EOF
  fi
}

make_conf(){
  url="$1"
  user="$2"
  pass_plain="$3"
  vendor="$4"
  pass_obsc="$(rclone obscure "${pass_plain}" 2>/dev/null || true)"
  cat > "${RCLONE_CONF}" <<EOF
[webdav]
type = webdav
url = ${url}
vendor = ${vendor}
user = ${user}
pass = ${pass_obsc}
EOF
}

read_setting_bool(){
  key="$1"
  def="$2"
  if [ ! -f "${SETTINGS}" ]; then echo "${def}"; return; fi
  v="$(sed -n 's/.*"'${key}'"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "${SETTINGS}" | head -n1)"
  if [ -z "${v}" ]; then echo "${def}"; else echo "${v}"; fi
}

read_setting_int(){
  key="$1"
  def="$2"
  if [ ! -f "${SETTINGS}" ]; then echo "${def}"; return; fi
  v="$(sed -n 's/.*"'${key}'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${SETTINGS}" | head -n1)"
  if [ -z "${v}" ]; then echo "${def}"; else echo "${v}"; fi
}

read_setting_str(){
  key="$1"
  def="$2"
  if [ ! -f "${SETTINGS}" ]; then echo "${def}"; return; fi
  v="$(sed -n 's/.*"'${key}'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${SETTINGS}" | head -n1)"
  if [ -z "${v}" ]; then echo "${def}"; else echo "${v}"; fi
}

run_sync(){
  enabled="$1"
  url="$2"
  remote_path="$3"
  user="$4"
  pass_plain="$5"
  mode="$6"
  no_deletes="$7"

  if [ "${enabled}" != "true" ]; then
    return 0
  fi

  if [ -z "${url}" ] || [ -z "${remote_path}" ] || [ -z "${user}" ] || [ -z "${pass_plain}" ]; then
    log "sync skipped (missing settings)"
    return 2
  fi

  vendor="other"
  make_conf "${url}" "${user}" "${pass_plain}" "${vendor}"
  remote="webdav:${remote_path}"

  log "sync start mode=${mode} remote=${remote} no_deletes=${no_deletes}"

  if [ "${mode}" = "pull" ]; then
    if [ "${no_deletes}" = "true" ]; then
      rclone copy "${remote}" "${NOTES_DIR}" --config "${RCLONE_CONF}" >> "${LOG_FILE}" 2>&1
    else
      rclone sync "${remote}" "${NOTES_DIR}" --config "${RCLONE_CONF}" >> "${LOG_FILE}" 2>&1
    fi
  elif [ "${mode}" = "bisync" ]; then
    bisync_extra=""
    if [ "${no_deletes}" = "true" ]; then
      bisync_extra="--no-cleanup"
    fi
    rclone bisync "${NOTES_DIR}" "${remote}" --workdir "${WORKDIR}" --config "${RCLONE_CONF}" --check-access --fast-list ${bisync_extra} >> "${LOG_FILE}" 2>&1
  else
    if [ "${no_deletes}" = "true" ]; then
      rclone copy "${NOTES_DIR}" "${remote}" --config "${RCLONE_CONF}" >> "${LOG_FILE}" 2>&1
    else
      rclone sync "${NOTES_DIR}" "${remote}" --config "${RCLONE_CONF}" >> "${LOG_FILE}" 2>&1
    fi
  fi

  log "sync done"
}

log "rclone sidecar started"

while true; do
  enabled="$(read_setting_bool enabled false)"
  url="$(read_setting_str webdav_url "")"
  remote_path="$(read_setting_str remote_path "")"
  user="$(read_setting_str username "")"
  pass_plain="$(read_setting_str password "")"
  mode="$(read_setting_str mode push)"
  interval_s="$(read_setting_int interval_s 60)"
  no_deletes="$(read_setting_bool no_deletes true)"
  paused="$(read_setting_bool paused false)"

  do_run="false"
  if [ -f "${RUN_ONCE}" ]; then
    do_run="true"
    rm -f "${RUN_ONCE}" || true
  fi

  if [ "${paused}" = "true" ]; then
    do_run="false"
  elif [ "${enabled}" = "true" ] && [ "${do_run}" = "false" ]; then
    do_run="true"
  fi

  if [ "${do_run}" = "true" ]; then
    set +e
    run_sync "${enabled}" "${url}" "${remote_path}" "${user}" "${pass_plain}" "${mode}" "${no_deletes}"
    rc=$?
    set -e
    if [ $rc -eq 0 ]; then
      write_status "ok"
    else
      write_status "error" "rclone exit ${rc}"
    fi
  else
    if [ "${paused}" = "true" ]; then
      write_status "paused"
    else
      write_status "idle"
    fi
  fi

  if [ -z "${interval_s}" ]; then interval_s="60"; fi
  if [ "${interval_s}" -lt 10 ] 2>/dev/null; then interval_s="10"; fi
  sleep "${interval_s}"
done

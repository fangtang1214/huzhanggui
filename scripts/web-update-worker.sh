#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/huzhanggui-updater"
REQUEST_PATH="$STATE_DIR/request"
PROCESSING_PATH="$STATE_DIR/request.processing"
STATUS_PATH="$STATE_DIR/status.json"
LOG_PATH="$STATE_DIR/update.log"
LOCK_PATH="/run/lock/huzhanggui-web-update.lock"
INSTALL_DIR="/opt/huzhanggui"

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  exit 0
fi
if [ ! -f "$REQUEST_PATH" ] && [ -f "$PROCESSING_PATH" ]; then
  mv -f "$PROCESSING_PATH" "$REQUEST_PATH"
fi
if [ ! -f "$REQUEST_PATH" ]; then
  exit 0
fi

touch "$LOG_PATH"
chown 1001:1001 "$LOG_PATH"
chmod 0640 "$LOG_PATH"

mv -f "$REQUEST_PATH" "$PROCESSING_PATH"
REQUESTED_AT="$(sed -n 's/.*"requestedAt":"\([^"]*\)".*/\1/p' "$PROCESSING_PATH" | head -n 1)"
REQUESTED_AT="${REQUESTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION_BEFORE="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || printf unknown)"

write_status() {
  local content="$1"
  local temporary
  temporary="$(mktemp "$STATE_DIR/.status-XXXXXX")"
  printf '%s\n' "$content" > "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$STATUS_PATH"
}

write_status "{\"state\":\"running\",\"requestedAt\":\"$REQUESTED_AT\",\"startedAt\":\"$STARTED_AT\",\"versionBefore\":\"$VERSION_BEFORE\"}"
printf '\n===== %s web update started (%s) =====\n' "$STARTED_AT" "$VERSION_BEFORE" >> "$LOG_PATH"

set +e
# 通过 Bash 调用，避免安装目录从压缩包、旧版 Git 或备份恢复后丢失可执行位而导致退出码 126。
bash "$INSTALL_DIR/update.sh" >> "$LOG_PATH" 2>&1
RESULT=$?
set -e

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION_AFTER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || printf unknown)"
if [ "$RESULT" -eq 0 ]; then
  write_status "{\"state\":\"succeeded\",\"requestedAt\":\"$REQUESTED_AT\",\"startedAt\":\"$STARTED_AT\",\"finishedAt\":\"$FINISHED_AT\",\"versionBefore\":\"$VERSION_BEFORE\",\"versionAfter\":\"$VERSION_AFTER\"}"
  printf '===== %s web update succeeded (%s) =====\n' "$FINISHED_AT" "$VERSION_AFTER" >> "$LOG_PATH"
else
  write_status "{\"state\":\"failed\",\"requestedAt\":\"$REQUESTED_AT\",\"startedAt\":\"$STARTED_AT\",\"finishedAt\":\"$FINISHED_AT\",\"versionBefore\":\"$VERSION_BEFORE\",\"versionAfter\":\"$VERSION_AFTER\",\"exitCode\":$RESULT}"
  printf '===== %s web update failed (exit %s) =====\n' "$FINISHED_AT" "$RESULT" >> "$LOG_PATH"
fi
rm -f "$PROCESSING_PATH"
exit "$RESULT"

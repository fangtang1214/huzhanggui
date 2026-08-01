#!/bin/sh
set -eu

last_backup_date=""

while true; do
  current_date="$(TZ=Asia/Shanghai date +%Y%m%d)"
  current_time="$(TZ=Asia/Shanghai date +%H%M)"

  if [ "$current_time" -ge "0300" ] && [ "$last_backup_date" != "$current_date" ]; then
    filename="/backups/siyuan-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S).dump"
    if pg_dump --format=custom --compress=9 --file="$filename"; then
      echo "已创建每日备份：$filename"
      find /backups -type f -name 'siyuan-*.dump' -mtime +29 -delete
      last_backup_date="$current_date"
    else
      echo "数据库备份失败，将在一分钟后重试" >&2
    fi
  fi

  sleep 60
done


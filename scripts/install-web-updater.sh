#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="/var/lib/huzhanggui-updater"

if [ "$(id -u)" -ne 0 ]; then
  echo "网页更新服务必须由 root 安装。"
  exit 1
fi

install -d -o 1001 -g 1001 -m 0750 "$STATE_DIR"
WORKER_TEMP="$(mktemp /usr/local/sbin/.huzhanggui-web-update-XXXXXX)"
install -m 0755 "$SOURCE_DIR/web-update-worker.sh" "$WORKER_TEMP"
mv -f "$WORKER_TEMP" /usr/local/sbin/huzhanggui-web-update

cat > /etc/systemd/system/huzhanggui-web-update.service <<'EOF'
[Unit]
Description=HuZhangGui controlled web update worker
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/huzhanggui-web-update
TimeoutStartSec=infinity
UMask=0027
EOF

cat > /etc/systemd/system/huzhanggui-web-update.path <<'EOF'
[Unit]
Description=Watch for HuZhangGui web update requests

[Path]
PathExists=/var/lib/huzhanggui-updater/request
PathExists=/var/lib/huzhanggui-updater/request.processing
Unit=huzhanggui-web-update.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now huzhanggui-web-update.path >/dev/null

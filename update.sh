#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/siyuan"
if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行更新命令。"
  exit 1
fi
if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "没有找到已安装的斯源样品管理系统。"
  exit 1
fi

cd "$INSTALL_DIR"
git pull --ff-only
docker compose up -d --build --remove-orphans
docker image prune -f
echo "系统已更新，现有数据库和备份均已保留。"


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

echo "正在等待系统完成启动..."
READY=0
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 3
done
if [ "$READY" -ne 1 ]; then
  echo "系统未能按时启动，请运行：cd /opt/siyuan && docker compose logs app"
  exit 1
fi

# 首次安装曾在启动阶段中断时，.env 仍可能保留初始管理员密码；健康后统一清除。
BOOTSTRAP_PLACEHOLDER="$(openssl rand -hex 32)"
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$BOOTSTRAP_PLACEHOLDER/" .env
docker compose up -d --force-recreate app >/dev/null
docker image prune -f
echo "系统已更新，现有数据库和备份均已保留。"

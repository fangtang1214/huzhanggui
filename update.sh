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

DEPLOY_MODE="$(sed -n 's/^DEPLOY_MODE=//p' .env | tail -n 1)"
if [ -z "$DEPLOY_MODE" ]; then
  if systemctl is-active --quiet nginx; then
    DEPLOY_MODE="nginx"
  else
    DEPLOY_MODE="caddy"
  fi
  echo "DEPLOY_MODE=$DEPLOY_MODE" >> .env
fi

if [ "$DEPLOY_MODE" = "nginx" ]; then
  APP_PORT_VALUE="$(sed -n 's/^APP_PORT=//p' .env | tail -n 1)"
  if [ -z "$APP_PORT_VALUE" ]; then
    for candidate in 8800 8000 8080 8008; do
      if ! ss -H -ltn "sport = :$candidate" | grep -q .; then
        APP_PORT_VALUE="$candidate"
        echo "APP_PORT=$APP_PORT_VALUE" >> .env
        break
      fi
    done
  fi
  if [ -z "$APP_PORT_VALUE" ]; then
    echo "备用端口 8800、8000、8080、8008 均已被占用，请先释放其中一个端口。"
    exit 1
  fi
  docker compose --profile caddy rm -sf caddy >/dev/null 2>&1 || true
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.nginx.yml)
  "${COMPOSE[@]}" up -d --build --remove-orphans database backup-init model-init vision indexer app backup
else
  COMPOSE=(docker compose --profile caddy)
  "${COMPOSE[@]}" up -d --build --remove-orphans
fi

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
"${COMPOSE[@]}" up -d --force-recreate app >/dev/null
docker image prune -f
echo "系统已更新，现有数据库和备份均已保留。"
if [ "$DEPLOY_MODE" = "nginx" ]; then
  echo "应用内部端口：http://127.0.0.1:$APP_PORT_VALUE"
  echo "请让现有 Nginx 将系统域名反向代理到此地址。"
fi

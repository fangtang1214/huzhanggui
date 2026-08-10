#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/huzhanggui"
LEGACY_DIR="/opt/siyuan"
REPO_URL="https://github.com/fangtang1214/huzhanggui.git"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行更新命令。"
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  CURRENT_DIR="$INSTALL_DIR"
  NEEDS_RENAME=0
elif [ -d "$LEGACY_DIR/.git" ]; then
  CURRENT_DIR="$LEGACY_DIR"
  NEEDS_RENAME=1
else
  echo "没有找到已安装的狐掌柜-直播样品管理系统。"
  exit 1
fi

if [ "$NEEDS_RENAME" -eq 1 ] && [ -e "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR 已存在，无法自动迁移旧目录。请先确认该目录内容。"
  exit 1
fi
if [ "$NEEDS_RENAME" -eq 0 ] && [ -f "$INSTALL_DIR/.huzhanggui-migrated-from-siyuan" ] && [ ! -e "$LEGACY_DIR" ] && [ ! -L "$LEGACY_DIR" ]; then
  ln -s "$INSTALL_DIR" "$LEGACY_DIR"
fi

read_env() {
  sed -n "s/^$1=//p" "$CURRENT_DIR/.env" | tail -n 1
}

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

cd "$CURRENT_DIR"
git remote set-url origin "$REPO_URL"
git pull --ff-only
if [ "${HUZHANGGUI_UPDATE_REEXEC:-0}" != "1" ]; then
  export HUZHANGGUI_UPDATE_REEXEC=1
  exec bash "$CURRENT_DIR/update.sh"
fi

DEPLOY_MODE="$(read_env DEPLOY_MODE)"
if [ -z "$DEPLOY_MODE" ]; then
  if systemctl is-active --quiet nginx; then
    DEPLOY_MODE="nginx"
  else
    DEPLOY_MODE="caddy"
  fi
  echo "DEPLOY_MODE=$DEPLOY_MODE" >> .env
fi

APP_PORT_VALUE="$(read_env APP_PORT)"
if [ "$DEPLOY_MODE" = "nginx" ] && [ -z "$APP_PORT_VALUE" ]; then
  for candidate in 8800 8000 8080 8008; do
    if ! ss -H -ltn "sport = :$candidate" | grep -q .; then
      APP_PORT_VALUE="$candidate"
      echo "APP_PORT=$APP_PORT_VALUE" >> .env
      break
    fi
  done
  if [ -z "$APP_PORT_VALUE" ]; then
    echo "备用端口 8800、8000、8080、8008 均已被占用，请先释放其中一个端口。"
    exit 1
  fi
fi

if [ "$NEEDS_RENAME" -eq 1 ]; then
  echo "检测到旧版安装，正在创建升级前备份并迁移数据..."
  if [ "$DEPLOY_MODE" = "nginx" ]; then
    LEGACY_COMPOSE=(docker compose -p siyuan -f docker-compose.yml -f docker-compose.nginx.yml)
  else
    LEGACY_COMPOSE=(docker compose -p siyuan --profile caddy)
  fi

  OLD_DB="$(read_env POSTGRES_DB)"
  OLD_USER="$(read_env POSTGRES_USER)"
  POSTGRES_PASSWORD="$(read_env POSTGRES_PASSWORD)"
  OLD_DB="${OLD_DB:-siyuan}"
  OLD_USER="${OLD_USER:-siyuan}"
  if [ -z "$POSTGRES_PASSWORD" ]; then
    echo "旧版 .env 缺少 POSTGRES_PASSWORD，已停止迁移。"
    exit 1
  fi

  "${LEGACY_COMPOSE[@]}" up -d database backup-init >/dev/null
  DATABASE_READY=0
  for _ in $(seq 1 60); do
    if "${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" database \
      psql -h 127.0.0.1 -U "$OLD_USER" -d postgres -Atc "SELECT 1" >/dev/null 2>&1; then
      DATABASE_READY=1
      break
    fi
    if "${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" database \
      psql -h 127.0.0.1 -U huzhanggui -d postgres -Atc "SELECT 1" >/dev/null 2>&1; then
      OLD_USER="huzhanggui"
      DATABASE_READY=1
      break
    fi
    sleep 2
  done
  if [ "$DATABASE_READY" -ne 1 ]; then
    echo "旧数据库未能启动，已停止迁移。"
    exit 1
  fi

  ACTIVE_DB="$("${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" database \
    psql -h 127.0.0.1 -U "$OLD_USER" -d postgres -Atc \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname='huzhanggui') THEN 'huzhanggui' ELSE 'siyuan' END")"
  BACKUP_STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
  "${LEGACY_COMPOSE[@]}" run --rm --no-deps \
    -e PGUSER="$OLD_USER" -e PGDATABASE="$ACTIVE_DB" -e PGPASSWORD="$POSTGRES_PASSWORD" \
    --entrypoint /bin/sh backup -c \
    "pg_dump --format=custom --compress=9 --file=/backups/huzhanggui-$BACKUP_STAMP.dump" >/dev/null
  echo "升级前数据库备份已创建。"

  "${LEGACY_COMPOSE[@]}" stop app indexer backup vision caddy >/dev/null 2>&1 || true

  MIGRATION_PASSWORD="$(openssl rand -hex 24)"
  "${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" database \
    psql -h 127.0.0.1 -U "$OLD_USER" -d postgres -v ON_ERROR_STOP=1 \
    --set=migration_password="$MIGRATION_PASSWORD" <<'SQL'
DROP ROLE IF EXISTS huzhanggui_rename_admin;
CREATE ROLE huzhanggui_rename_admin WITH LOGIN SUPERUSER PASSWORD :'migration_password';
SQL

  OLD_DATABASE_EXISTS="$("${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$MIGRATION_PASSWORD" database \
    psql -h 127.0.0.1 -U huzhanggui_rename_admin -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='siyuan'")"
  NEW_DATABASE_EXISTS="$("${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$MIGRATION_PASSWORD" database \
    psql -h 127.0.0.1 -U huzhanggui_rename_admin -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='huzhanggui'")"
  if [ "$OLD_DATABASE_EXISTS" = "1" ] && [ "$NEW_DATABASE_EXISTS" != "1" ]; then
    "${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$MIGRATION_PASSWORD" database \
      psql -h 127.0.0.1 -U huzhanggui_rename_admin -d postgres -v ON_ERROR_STOP=1 \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='siyuan' AND pid <> pg_backend_pid();" \
      -c 'ALTER DATABASE siyuan RENAME TO huzhanggui;' >/dev/null
  fi

  OLD_ROLE_EXISTS="$("${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$MIGRATION_PASSWORD" database \
    psql -h 127.0.0.1 -U huzhanggui_rename_admin -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname='siyuan'")"
  NEW_ROLE_EXISTS="$("${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$MIGRATION_PASSWORD" database \
    psql -h 127.0.0.1 -U huzhanggui_rename_admin -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname='huzhanggui'")"
  if [ "$OLD_ROLE_EXISTS" = "1" ] && [ "$NEW_ROLE_EXISTS" != "1" ]; then
    "${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$MIGRATION_PASSWORD" database \
      psql -h 127.0.0.1 -U huzhanggui_rename_admin -d postgres -v ON_ERROR_STOP=1 \
      -c 'ALTER ROLE siyuan RENAME TO huzhanggui;' >/dev/null
  fi
  "${LEGACY_COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" database \
    psql -h 127.0.0.1 -U huzhanggui -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP ROLE IF EXISTS huzhanggui_rename_admin;' >/dev/null

  volume_name() {
    local logical_name="$1"
    local found
    found="$(docker volume ls \
      --filter "label=com.docker.compose.project=siyuan" \
      --filter "label=com.docker.compose.volume=$logical_name" \
      --format '{{.Name}}' | head -n 1)"
    if [ -z "$found" ] && docker volume inspect "siyuan_$logical_name" >/dev/null 2>&1; then
      found="siyuan_$logical_name"
    fi
    printf '%s' "$found"
  }

  DATABASE_VOLUME="$(volume_name database_data)"
  BACKUP_VOLUME="$(volume_name backup_data)"
  MODEL_VOLUME="$(volume_name model_cache)"
  CADDY_DATA_VOLUME="$(volume_name caddy_data)"
  CADDY_CONFIG_VOLUME="$(volume_name caddy_config)"
  if [ -z "$DATABASE_VOLUME" ] || [ -z "$BACKUP_VOLUME" ]; then
    echo "未找到旧版数据库卷或备份卷，已停止迁移。"
    exit 1
  fi

  "${LEGACY_COMPOSE[@]}" stop database backup-init model-init >/dev/null 2>&1 || true
  "${LEGACY_COMPOSE[@]}" down --remove-orphans >/dev/null

  copy_volume() {
    local source="$1"
    local target="$2"
    local logical_name="$3"
    local marker="$CURRENT_DIR/.huzhanggui-volume-$logical_name"
    if [ -z "$source" ]; then
      return
    fi
    if docker volume inspect "$target" >/dev/null 2>&1; then
      if [ -f "$marker" ]; then
        return
      fi
      if ! docker run --rm -v "$target:/data" alpine:3.22 sh -c '[ -z "$(ls -A /data)" ]'; then
        echo "目标数据卷 $target 已存在且非空，为避免覆盖数据已停止迁移。"
        exit 1
      fi
    else
      docker volume create \
        --label com.docker.compose.project=huzhanggui \
        --label "com.docker.compose.volume=$logical_name" \
        "$target" >/dev/null
    fi
    docker run --rm -v "$source:/source:ro" -v "$target:/target" alpine:3.22 \
      sh -c 'cd /source && cp -a . /target/'
    touch "$marker"
  }

  copy_volume "$DATABASE_VOLUME" huzhanggui_database_data database_data
  copy_volume "$BACKUP_VOLUME" huzhanggui_backup_data backup_data
  copy_volume "$MODEL_VOLUME" huzhanggui_model_cache model_cache
  copy_volume "$CADDY_DATA_VOLUME" huzhanggui_caddy_data caddy_data
  copy_volume "$CADDY_CONFIG_VOLUME" huzhanggui_caddy_config caddy_config

  set_env POSTGRES_DB huzhanggui
  set_env POSTGRES_USER huzhanggui
  set_env DATABASE_URL "postgres://huzhanggui:$POSTGRES_PASSWORD@database:5432/huzhanggui"
  set_env COMPOSE_PROJECT_NAME huzhanggui
  touch "$CURRENT_DIR/.huzhanggui-migrated-from-siyuan"

  cd /opt
  mv "$LEGACY_DIR" "$INSTALL_DIR"
  ln -s "$INSTALL_DIR" "$LEGACY_DIR"
  CURRENT_DIR="$INSTALL_DIR"
  cd "$CURRENT_DIR"

  rm -f .huzhanggui-volume-*
  echo "旧版目录、数据库、账号和数据卷已完成迁移；旧路径已保留兼容入口。"
fi

cd "$CURRENT_DIR"
bash scripts/install-web-updater.sh
if [ "$DEPLOY_MODE" = "nginx" ]; then
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.nginx.yml)
  docker compose --profile caddy rm -sf caddy >/dev/null 2>&1 || true
else
  COMPOSE=(docker compose --profile caddy)
fi

"${COMPOSE[@]}" up -d database backup-init >/dev/null
DATABASE_READY=0
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T database sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    DATABASE_READY=1
    break
  fi
  sleep 2
done
if [ "$DATABASE_READY" -ne 1 ]; then
  echo "数据库未能就绪，已停止更新。"
  exit 1
fi
BACKUP_STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
"${COMPOSE[@]}" run --rm --no-deps --entrypoint /bin/sh backup -c \
  "pg_dump --format=custom --compress=9 --file=/backups/huzhanggui-$BACKUP_STAMP.dump" >/dev/null
echo "升级前数据库备份已创建。"

if [ "$DEPLOY_MODE" = "nginx" ]; then
  "${COMPOSE[@]}" up -d --build --remove-orphans database backup-init model-init vision indexer league-sync app backup
else
  "${COMPOSE[@]}" up -d --build --remove-orphans
fi

echo "正在等待系统完成启动..."
READY=0
for _ in $(seq 1 200); do
  if "${COMPOSE[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 3
done
if [ "$READY" -ne 1 ]; then
  echo "系统未能按时启动，请运行：cd /opt/huzhanggui && docker compose logs app"
  exit 1
fi

# 首次安装曾在启动阶段中断时，.env 仍可能保留初始管理员密码；健康后统一清除。
BOOTSTRAP_PLACEHOLDER="$(openssl rand -hex 32)"
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$BOOTSTRAP_PLACEHOLDER/" .env
"${COMPOSE[@]}" up -d --force-recreate app >/dev/null
docker image prune -f
echo "狐掌柜已更新，现有数据库、账号、备份和图片识别模型均已保留。"
if [ "$DEPLOY_MODE" = "nginx" ]; then
  echo "应用内部端口：http://127.0.0.1:$APP_PORT_VALUE"
  echo "请让现有 Nginx 将系统域名反向代理到此地址。"
fi

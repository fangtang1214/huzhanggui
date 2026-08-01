#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SIYUAN_REPO_URL:-https://github.com/REPLACE_GITHUB_USER/siyuan.git}"
INSTALL_DIR="/opt/siyuan"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行安装命令。"
  exit 1
fi

if [ -t 0 ]; then
  input="/dev/stdin"
else
  input="/dev/tty"
fi

echo "======================================"
echo "  斯源直播样品管理系统 · 一键安装"
echo "======================================"
echo

read -r -p "请输入已解析到本服务器的域名（例如 sample.example.com）：" DOMAIN < "$input"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "域名格式不正确。"
  exit 1
fi

read -r -p "请输入初始管理员账号 [admin]：" ADMIN_USERNAME < "$input"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
read -r -p "请输入管理员姓名 [系统管理员]：" ADMIN_NAME < "$input"
ADMIN_NAME="${ADMIN_NAME:-系统管理员}"
read -r -s -p "请设置管理员密码（至少 8 位）：" ADMIN_PASSWORD < "$input"
echo
if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
  echo "密码至少需要 8 位。"
  exit 1
fi
if [[ ! "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "管理员账号只能包含字母、数字、点、横线或下划线。"
  exit 1
fi
if [[ ! "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9@%+=_.!-]+$ ]]; then
  echo "密码可使用字母、数字以及 @ % + = _ . ! - 这些符号。"
  exit 1
fi

echo "正在准备服务器环境..."
apt-get update -y
apt-get install -y ca-certificates curl git openssl

if ! command -v docker >/dev/null 2>&1; then
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    echo "当前一键安装仅支持 Ubuntu 22.04 / 24.04。"
    exit 1
  fi
  for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    apt-get remove -y "$package" >/dev/null 2>&1 || true
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

if [ -e "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR 已存在。请先运行更新脚本，或备份后移除旧目录。"
  exit 1
fi

git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

POSTGRES_PASSWORD="$(openssl rand -hex 24)"
SESSION_SECRET="$(openssl rand -hex 48)"
cat > .env <<EOF
DOMAIN=$DOMAIN
POSTGRES_DB=siyuan
POSTGRES_USER=siyuan
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DATABASE_URL=postgres://siyuan:$POSTGRES_PASSWORD@database:5432/siyuan
SESSION_SECRET=$SESSION_SECRET
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_NAME=$ADMIN_NAME
TZ=Asia/Shanghai
EOF
chmod 600 .env

docker compose up -d --build

echo "正在等待系统完成首次初始化..."
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

# 初始管理员已经写入数据库；移除容器环境中的明文初始密码。
BOOTSTRAP_PLACEHOLDER="$(openssl rand -hex 32)"
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$BOOTSTRAP_PLACEHOLDER/" .env
docker compose up -d --force-recreate app >/dev/null

echo
echo "安装完成。"
echo "访问地址：https://$DOMAIN"
echo "管理员账号：$ADMIN_USERNAME"
echo "如域名刚完成解析，HTTPS 证书可能需要等待几分钟。"

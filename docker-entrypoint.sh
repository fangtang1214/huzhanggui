#!/bin/sh
set -eu

echo "正在检查数据库结构..."
node scripts/migrate.mjs
node scripts/seed.mjs

echo "狐掌柜-直播样品管理系统正在启动..."
exec node server.js

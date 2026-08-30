#!/usr/bin/env sh
# 一键生成 Docker 部署用 .env（随机密钥，内置模式开箱即用）
# 用法：
#   ./scripts/gen-env.sh             # 内置 MySQL 模式
#   ./scripts/gen-env.sh --external  # 外置 MySQL 模式（生成后需手动填 DATABASE_URL）
#   ./scripts/gen-env.sh --force     # 覆盖已存在的 .env
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET="$ROOT/.env"
MODE="builtin"

for arg in "$@"; do
  case "$arg" in
    --external) MODE="external" ;;
    --force) FORCE=1 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

if [ -f "$TARGET" ] && [ -z "${FORCE:-}" ]; then
  echo ".env 已存在（如需重新生成请加 --force，注意旧密钥对应的加密数据将失效）"
  exit 1
fi

hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ROOT_PASSWORD=$(hex 12)
DB_PASSWORD=$(hex 12)
ENCRYPTION_KEY=$(hex 32)
JWT_SECRET=$(hex 32)

if [ "$MODE" = "external" ]; then
  cat > "$TARGET" <<EOF
# ===== 外置 MySQL 模式（docker-compose.external.yml）=====
APP_VERSION=0.1.0

# 【必填】目标数据库连接串（应用将自动建表；库需已创建且账号有建表权限）
# 密码含特殊字符需 URL 编码：! → %21  @ → %40  & → %26  # → %23
DATABASE_URL=mysql://user:password@192.168.1.10:3306/due_reminder?connection_limit=10

# 环境主密钥（随机生成，部署后不可更改，务必备份）
ENCRYPTION_KEY=$ENCRYPTION_KEY
# JWT 密钥（随机生成）
JWT_SECRET=$JWT_SECRET
# HTTPS 部署保持 true；仅局域网纯 HTTP 部署才设 false
COOKIE_SECURE=true

# 每日提醒推送时刻（小时，0-23，上海时区）
REMINDER_HOUR=8
# Bark 推送地址（可选；也可登录后在「系统设置」页配置）
BARK_URL=
# 应用显示名（可选，留空使用默认「守候信用卡小管家」）
APP_NAME=
# 宿主机绑定地址与对外端口
APP_BIND_IP=0.0.0.0
APP_PORT=3000
EOF
  echo "已生成外置 MySQL 模式的 .env：$TARGET"
  echo "请打开 .env 填写 DATABASE_URL 后，依次执行："
  echo "docker compose -f docker-compose.external.yml pull"
  echo "docker compose -f docker-compose.external.yml up -d"
else
  cat > "$TARGET" <<EOF
# ===== 内置 MySQL 模式（docker-compose.yml，密钥已随机生成）=====
APP_VERSION=0.1.0

# MySQL root 密码（随机生成，务必备份）
MYSQL_ROOT_PASSWORD=$ROOT_PASSWORD
# MySQL 业务账号密码（随机生成）
MYSQL_PASSWORD=$DB_PASSWORD

# 环境主密钥（随机生成，部署后不可更改，务必备份）
ENCRYPTION_KEY=$ENCRYPTION_KEY
# JWT 密钥（随机生成）
JWT_SECRET=$JWT_SECRET
# HTTPS 部署保持 true；仅局域网纯 HTTP 部署才设 false
COOKIE_SECURE=true

# 每日提醒推送时刻（小时，0-23，上海时区）
REMINDER_HOUR=8
# Bark 推送地址（可选；也可登录后在「系统设置」页配置）
BARK_URL=
# 应用显示名（可选，留空使用默认「守候信用卡小管家」）
APP_NAME=
# 宿主机绑定地址与对外端口
APP_BIND_IP=0.0.0.0
APP_PORT=3000
EOF
  echo "已生成内置 MySQL 模式的 .env：$TARGET"
  echo "依次执行：docker compose pull && docker compose up -d"
fi

# 一键生成 Docker 部署用 .env（随机密钥，内置模式开箱即用）
# 用法：
#   pwsh ./scripts/gen-env.ps1            # 内置 MySQL 模式
#   pwsh ./scripts/gen-env.ps1 -External  # 外置 MySQL 模式（生成后需手动填 DATABASE_URL）
#   pwsh ./scripts/gen-env.ps1 -Force     # 覆盖已存在的 .env
param(
    [switch]$External,
    [switch]$Force
)

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root '.env'

if ((Test-Path $target) -and -not $Force) {
    Write-Host ".env 已存在（如需重新生成请加 -Force，注意旧密钥对应的加密数据将失效）" -ForegroundColor Yellow
    exit 1
}

function New-Hex([int]$bytes) {
    $buf = [byte[]]::new($bytes)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buf)
    -join ($buf | ForEach-Object { $_.ToString('x2') })
}

$rootPassword = New-Hex 12
$dbPassword = New-Hex 12
$encryptionKey = New-Hex 32
$jwtSecret = New-Hex 32

if ($External) {
    $content = @"
# ===== 外置 MySQL 模式（docker-compose.external.yml）=====
APP_VERSION=0.4.0

# 【必填】目标数据库连接串（应用将自动建表；库需已创建且账号有建表权限）
# 密码含特殊字符需 URL 编码：! → %21  @ → %40  & → %26  # → %23
DATABASE_URL=mysql://user:password@192.168.1.10:3306/due_reminder?connection_limit=10

# 环境主密钥（随机生成，部署后不可更改，务必备份）
ENCRYPTION_KEY=$encryptionKey
# JWT 密钥（随机生成）
JWT_SECRET=$jwtSecret
# HTTPS 部署保持 true；仅局域网纯 HTTP 部署才设 false
COOKIE_SECURE=true

# 每日提醒推送时刻（小时，0-23，上海时区）
REMINDER_HOUR=8
# 应用显示名（可选，留空使用默认「守候信用卡小管家」）
APP_NAME=
# 宿主机绑定地址与对外端口
APP_BIND_IP=0.0.0.0
APP_PORT=3000
"@
    $mode = '外置 MySQL'
} else {
    $content = @"
# ===== 内置 MySQL 模式（docker-compose.yml，密钥已随机生成）=====
APP_VERSION=0.4.0

# MySQL root 密码（随机生成，务必备份）
MYSQL_ROOT_PASSWORD=$rootPassword
# MySQL 业务账号密码（随机生成）
MYSQL_PASSWORD=$dbPassword

# 环境主密钥（随机生成，部署后不可更改，务必备份）
ENCRYPTION_KEY=$encryptionKey
# JWT 密钥（随机生成）
JWT_SECRET=$jwtSecret
# HTTPS 部署保持 true；仅局域网纯 HTTP 部署才设 false
COOKIE_SECURE=true

# 每日提醒推送时刻（小时，0-23，上海时区）
REMINDER_HOUR=8
# 应用显示名（可选，留空使用默认「守候信用卡小管家」）
APP_NAME=
# 宿主机绑定地址与对外端口
APP_BIND_IP=0.0.0.0
APP_PORT=3000
"@
    $mode = '内置 MySQL'
}

Set-Content -Path $target -Value $content -Encoding utf8NoBOM
Write-Host "已生成 $mode 模式的 .env：$target" -ForegroundColor Green
if ($External) {
    Write-Host "请打开 .env 填写 DATABASE_URL 后，依次执行：" -ForegroundColor Cyan
    Write-Host "docker compose -f docker-compose.external.yml pull" -ForegroundColor Cyan
    Write-Host "docker compose -f docker-compose.external.yml up -d" -ForegroundColor Cyan
} else {
    Write-Host "依次执行：docker compose pull；docker compose up -d" -ForegroundColor Cyan
}

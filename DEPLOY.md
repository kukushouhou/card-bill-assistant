# Docker 部署与运维指南

如果希望由 AI 根据 NAS/服务器环境生成具体方案，请使用 [AI_DEPLOYMENT_PROMPT.md](./AI_DEPLOYMENT_PROMPT.md)。

## 1. 选择数据库模式

### 内置 MySQL

适合首次部署、尚无受管 MySQL 的 NAS，使用 `docker-compose.yml`。MySQL 数据保存在 `db-data` Docker 卷中，不对宿主机暴露数据库端口。

```bash
sh ./scripts/gen-env.sh
docker compose config --quiet
docker compose up -d --build
```

### 外置 MySQL

适合已有独立备份和监控的 MySQL，使用 `docker-compose.external.yml`。目标数据库需要事先创建，账号需要建表和执行迁移的权限。

```bash
sh ./scripts/gen-env.sh --external
# 在目标主机本地编辑 .env 中的 DATABASE_URL
docker compose -f docker-compose.external.yml config --quiet
docker compose -f docker-compose.external.yml up -d --build
```

不要在终端记录、Issue 或对话中粘贴完整连接串。MySQL 密码含特殊字符时必须进行 URL 编码。

## 2. HTTPS 与网络

生产配置默认 `COOKIE_SECURE=true`，建议使用 NAS 反向代理、Caddy、Nginx Proxy Manager 或其他可信入口提供 HTTPS：

```text
https://cards.example.com
        ↓
http://NAS_IP:3000
```

如果反向代理与容器在同一主机且确实可访问回环地址，可将 `APP_BIND_IP` 设为 `127.0.0.1`。否则保持 `0.0.0.0`，并通过 NAS 防火墙限制访问范围。

仅在受信任局域网使用纯 HTTP 时，可在 `.env` 设置 `COOKIE_SECURE=false`。此模式没有传输加密，不得用于公网。

## 3. 首次启动

```bash
docker compose ps
docker compose logs --tail=200 app
curl -fsS http://127.0.0.1:3000/api/health
```

外置 MySQL 模式的命令需要加上 `-f docker-compose.external.yml`。

应用容器每次启动前会自动执行 `prisma migrate deploy`。首次访问时，Web 安装向导会完成数据库检查、管理员密码/可选 PIN、通知渠道和安装标记。

## 4. 备份

### 内置 MySQL 逻辑备份

```bash
mkdir -p backups
docker compose exec -T db sh -c \
  'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction due_reminder' \
  > "backups/due_reminder-$(date +%F-%H%M).sql"
```

备份文件应由 NAS 备份任务同步到其他介质。同时对 `.env` 进行加密备份；数据库与 `.env` 缺少任何一方，都无法完整恢复加密数据。PIN 不在 `.env` 或数据库中明文保存，应由用户自行安全保管。

### 恢复内置 MySQL

恢复前先确认目标数据库和备份时间，然后停止应用以避免写入：

```bash
docker compose stop app
docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" due_reminder' < backup.sql
docker compose start app
```

恢复是覆盖性操作，请优先在临时数据库中演练。

## 5. 升级

升级前必须完成数据库和 `.env` 备份，且不得重新运行密钥生成脚本。

```bash
git pull --ff-only
docker compose build --pull app
docker compose up -d
docker compose ps
docker compose logs --tail=200 app
```

外置 MySQL 模式将上述 Compose 命令改为 `docker compose -f docker-compose.external.yml ...`。数据库迁移失败时不要跳过迁移强制启动，应保留日志和备份后诊断。

## 6. 常用运维命令

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose stop
docker compose start
docker compose down
```

`docker compose down` 不会删除命名数据卷。不要执行 `docker compose down -v`，除非你已明确决定永久删除内置 MySQL 全部数据并已验证备份可恢复。

## 7. 常见故障

### 页面可打开，登录后立即返回登录页

检查实际访问是 HTTP 还是 HTTPS，并核对 `COOKIE_SECURE`。HTTPS 应设为 `true`，局域网纯 HTTP 需要显式设为 `false`。

### 数据库不健康

```bash
docker compose ps
docker compose logs --tail=200 db
docker compose logs --tail=200 app
```

检查 NAS 剩余空间、数据卷状态和 MySQL 日志。外置模式还需要检查数据库防火墙、账号权限和 URL 编码。

### 重新构建后无法解密数据

不要创建新的 `ENCRYPTION_KEY`。从加密备份恢复原 `.env`，并确认数据库与该密钥来自同一次部署。

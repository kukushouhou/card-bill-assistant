# 部署与运维指南

如果希望由 AI 根据 NAS/服务器环境生成具体方案，请使用 [AI_DEPLOYMENT_PROMPT.md](./AI_DEPLOYMENT_PROMPT.md)。

当前发布版本为 `v0.4.0`，官方多架构镜像为 `ghcr.io/kukushouhou/card-bill-assistant:0.4.0`，支持 `linux/amd64` 与 `linux/arm64`。生产环境建议固定 `APP_VERSION`，不要长期跟随 `latest`。

## 1. 官方镜像部署

先获取与镜像版本一致的部署文件：

```bash
git clone --branch v0.4.0 --depth 1 https://github.com/kukushouhou/card-bill-assistant.git
cd card-bill-assistant
```

### 选择数据库模式

### 内置 MySQL

适合首次部署、尚无受管 MySQL 的 NAS，使用 `docker-compose.yml`。MySQL 数据保存在 `db-data` Docker 卷中，不对宿主机暴露数据库端口。

```bash
sh ./scripts/gen-env.sh
docker compose config --quiet
docker compose pull
docker compose up -d
```

### 外置 MySQL

适合已有 MySQL 的环境，使用 `docker-compose.external.yml`。目标数据库需要事先创建，应用账号需要具备应用读写、建表和执行迁移的权限。外置数据库并不等于无法备份：部署环境能够连接数据库且账号具有导出所需权限时，也可以在升级前导出目标数据库。

```bash
sh ./scripts/gen-env.sh --external
# 在目标主机本地编辑 .env 中的 DATABASE_URL
docker compose -f docker-compose.external.yml config --quiet
docker compose -f docker-compose.external.yml pull
docker compose -f docker-compose.external.yml up -d
```

不要在终端记录、Issue 或对话中粘贴完整连接串。MySQL 密码含特殊字符时必须进行 URL 编码。

## 2. Docker 源码构建

仅在需要审阅或修改源码时叠加构建覆盖文件：

```bash
# 内置 MySQL
docker compose -f docker-compose.yml -f docker-compose.build.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

# 外置 MySQL
docker compose -f docker-compose.external.yml -f docker-compose.build.yml config --quiet
docker compose -f docker-compose.external.yml -f docker-compose.build.yml up -d --build
```

构建产物固定命名为 `card-bill-assistant:local`。应用启动时仍会先自动执行 `prisma migrate deploy`。

## 3. 手动源码部署（不使用 Docker）

环境要求：Node.js 24、MySQL 8，以及可长期守护 Node.js 进程的系统服务。

```bash
git clone --branch v0.4.0 --depth 1 https://github.com/kukushouhou/card-bill-assistant.git
cd card-bill-assistant

cd web
npm ci
npm run build

cd ../server
cp ../.env.example .env
# 在 server/.env 中填写 DATABASE_URL、ENCRYPTION_KEY、JWT_SECRET 等配置
# 通过 HTTPS 部署时将 COOKIE_SECURE 改为 true
npm ci --omit=dev
npx prisma generate
npx prisma migrate deploy
NODE_ENV=production npm start
```

`server` 会从相邻目录读取 `web/dist`。若目录结构不同，可将 `WEB_DIST_DIR` 指向前端构建产物的绝对路径。建议用 systemd、Supervisor 或 NAS 自带进程管理器守护，并将 HTTPS 反向代理指向 `127.0.0.1:3000`。

最小 systemd 服务示例（根据实际用户与路径修改）：

```ini
[Unit]
Description=Card Bill Assistant
After=network-online.target mysql.service

[Service]
Type=simple
User=card-assistant
WorkingDirectory=/opt/card-bill-assistant/server
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`.env` 保存在 `server/` 中且权限应限制为仅服务用户可读。升级时必须保留原 `.env`；数据库恢复点按实际数据库管理方式处理，再更新代码、重新构建前端、执行 `npm ci --omit=dev` 与 `npx prisma migrate deploy`，最后重启服务。

## 4. HTTPS 与网络

生产配置默认 `COOKIE_SECURE=true`，建议使用 NAS 反向代理、Caddy、Nginx Proxy Manager 或其他可信入口提供 HTTPS：

```text
https://cards.example.com
        ↓
http://NAS_IP:3000
```

如果反向代理与容器在同一主机且确实可访问回环地址，可将 `APP_BIND_IP` 设为 `127.0.0.1`。否则保持 `0.0.0.0`，并通过 NAS 防火墙限制访问范围。

仅在受信任局域网使用纯 HTTP 时，可在 `.env` 设置 `COOKIE_SECURE=false`。此模式没有传输加密，不得用于公网。

## 5. 首次启动

```bash
docker compose ps
docker compose logs --tail=200 app
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -o /dev/null http://127.0.0.1:3000/
curl -fsS -o /dev/null http://127.0.0.1:3000/login
```

外置 MySQL 模式的命令需要加上 `-f docker-compose.external.yml`。

三项检查分别验证 API、Web 首页和前端路由刷新回退。默认 Docker 部署不依赖 Nginx 伪静态，非 `/api` 路径由 Node 服务回退到 `index.html`。

应用容器每次启动前会自动执行 `prisma migrate deploy`。首次访问时，Web 安装向导会完成数据库检查、管理员密码/可选 PIN、通知渠道和安装标记。

## 6. 数据库备份与恢复

全新安装没有既有业务数据，不需要询问备份。升级时先核对目标版本的发布说明和数据库迁移文件：没有数据库变更就直接继续；只有目标版本会执行数据库结构或数据迁移时，才询问用户是否先备份，并推荐备份。该判断同时适用于内置和外置 MySQL。

用户确认需要备份后，再确认导出工具、数据库权限、可用空间、保存目录和文件名。默认使用带日期时间的新文件，避免覆盖历史备份；只有选定文件已经存在时，才询问是更换文件名还是覆盖，未经明确选择不得覆盖。

### 内置 MySQL 逻辑备份

```bash
mkdir -p backups
docker compose exec -T db sh -c \
  'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction due_reminder' \
  > "backups/due_reminder-$(date +%F-%H%M).sql"
```

备份文件应由 NAS 备份任务同步到其他介质。同时对 `.env` 进行加密备份；数据库与 `.env` 缺少任何一方，都无法完整恢复加密数据。PIN 不在 `.env` 或数据库中明文保存，应由用户自行安全保管。

### 外置 MySQL 逻辑备份

外置 MySQL 可以使用实际连接账号执行逻辑备份，前提是部署主机能够访问数据库，并且该账号对目标库具有导出所需的读取权限。下面示例会让 `mysqldump` 交互式询问密码，不要把密码直接写入命令历史：

```bash
mkdir -p backups
mysqldump --single-transaction --skip-lock-tables \
  --host=MYSQL_HOST --port=3306 --user=MYSQL_USER --password \
  DATABASE_NAME > "backups/DATABASE_NAME-$(date +%F-%H%M).sql"
```

如果目标数据库包含视图、触发器或事件，还需确认账号具有导出这些对象所需的权限。备份命令完成后应检查退出状态和文件非空，再启动会执行迁移的新版本。

### 恢复内置 MySQL

恢复前先确认目标数据库和备份时间，然后停止应用以避免写入：

```bash
docker compose stop app
docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" due_reminder' < backup.sql
docker compose start app
```

恢复是覆盖性操作，请优先在临时数据库中演练。

外置 MySQL 的恢复方式取决于数据库服务和账号权限。执行恢复前同样要停止应用写入，并优先在临时数据库验证备份；受管数据库已有快照或时间点恢复能力时，可以继续使用其现有恢复方案。

## 7. 升级

升级时必须保留原 `.env`，且不得重新运行密钥生成脚本。先判断当前版本到目标版本之间是否包含数据库结构或数据迁移：没有数据库变更时不询问备份；存在数据库变更时，才询问用户是否按上一节备份。内置和外置 MySQL 使用同一触发条件。只有用户选择备份后才确认保存位置；只有选定目标已经存在时才询问是否覆盖。

```bash
git fetch --tags
# 将 .env 中 APP_VERSION 改为准备升级并已阅读发布说明的版本
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 app
```

外置 MySQL 模式将上述 Compose 命令改为 `docker compose -f docker-compose.external.yml ...`。源码构建模式则使用对应双 `-f` 命令并增加 `--build`。数据库迁移失败时不要跳过迁移强制启动，应保留日志和当前镜像后诊断。

## 8. 常用运维命令

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose stop
docker compose start
docker compose down
```

`docker compose down` 不会删除命名数据卷。不要执行 `docker compose down -v`，除非你已明确决定永久删除内置 MySQL 全部数据并已验证备份可恢复。

## 9. 常见故障

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

# 守候信用卡小管家

[![CI](https://github.com/kukushouhou/card-bill-assistant/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kukushouhou/card-bill-assistant/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kukushouhou/card-bill-assistant)](https://github.com/kukushouhou/card-bill-assistant/releases)
[![License](https://img.shields.io/github/license/kukushouhou/card-bill-assistant)](./LICENSE)
[![GHCR](https://img.shields.io/badge/GHCR-card--bill--assistant-2496ED?logo=docker&logoColor=white)](https://github.com/users/kukushouhou/packages/container/package/card-bill-assistant)
![Platforms](https://img.shields.io/badge/platform-linux%2Famd64%20%7C%20linux%2Farm64-555?logo=linux&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)

一个面向个人自托管的信用卡账单与到期提醒工具。它会通过 IMAP 读取银行账单邮件，解析账单和交易明细，管理还款、年费及自定义提醒，并通过用户启用的通知渠道推送当日事项。

- 当前稳定版本：`v0.2.0`
- 官方容器镜像：`ghcr.io/kukushouhou/card-bill-assistant:0.2.0`

> 该项目处理邮箱授权码和信用卡信息，建议仅部署在可信设备上，使用 HTTPS，并定期备份数据库与 `.env`。不要将应用或 MySQL 端口直接暴露到公网。

## 目录

- [完整功能](#完整功能)
- [界面预览与设备支持](#界面预览与设备支持)
- [支持的银行邮件与解析层级](#支持的银行邮件与解析层级)
- [安全与数据边界](#安全与数据边界)
- [部署方式](#部署方式)
  - [使用 AI 协助部署（推荐）](#方式一使用-ai-协助部署推荐)
  - [手动使用官方 Docker 镜像](#方式二手动使用官方-docker-镜像)
  - [使用 Docker 从源码构建](#方式三使用-docker-从源码构建)
  - [手动源码部署（不使用 Docker）](#方式四手动源码部署不使用-docker)
- [本地开发](#本地开发)
- [新增银行解析器](#新增银行解析器)
- [技术栈](#技术栈)
- [许可证](#许可证)

## 完整功能

### 银行账单邮件同步与解析

- 支持绑定和管理多个 IMAP 邮箱账户，使用授权码连接；同步过程不会将邮件标记为已读，也不会删除邮件。
- 每 2 小时自动增量同步一次，也可手动同步、按配置范围重新同步，或首次安装后拉取全部历史邮件；同步日志会记录匹配、未匹配、图片账单和解析错误。
- 通过发件人、标题和模板特征识别银行账单，只有命中解析器的邮件才进入账单流程；营销邮件不会被误建为账单。
- 解析账单期、出账日、还款日、应还金额、最低还款额、币种、卡尾和交易明细，支持多币种及一封邮件包含多张卡的合并账单。
- 解析器按银行和模板年份版本化管理；解析器中心可查看匹配规则，并对用户自己的邮箱邮件进行试解析，便于定位模板变化。
- 招商银行「每日信用管家」可同步本账期的未出账单日度明细；正式账单生成后仍以正式账单作为还款与统计依据。

### 卡片中心与敏感卡信息

- 首次解析到账单时自动建立信用卡档案，也支持手动新增、编辑和删除卡片。
- 管理银行、卡尾、别名、持卡人、币种、出账日、还款规则、提醒提前天数和年费日；可将卡片标记为正常使用、冻结或注销。
- 同银行且出账日、还款规则一致的卡片自动归为套卡；支持选择「主卡」作为套卡列表中的优先展示卡，多卡账单仍保留各卡归属。
- 卡片直接展示本期应还、下一还款日和账期状态；支持按银行、出账日、还款日、年费日排序，以及按银行、卡尾、别名和持卡人搜索。
- 完整卡号、有效期和 CVV 使用「环境主密钥 + 用户 PIN」双密钥加密。每次查看或编辑敏感信息都要重新验证 PIN，离开页面后自动清除明文。

### 账单台账、交易明细与还款

- 统一展示银行正式账单、固定账单和动态账单，可按银行、卡片、币种、账期及还款状态筛选。
- 支持待还、部分已还、已还清和无需还款等状态；可记录实际还款金额、恢复待还、删除账单或将关联卡片标记为异常。
- 合并账单会关联套卡内的多张卡，交易明细按实际卡尾归属；明细支持按交易描述、银行、卡片、币种和日期检索。
- 未到银行账单时可在应有账期显示「未取得账单」占位，取得真实账单后自动由正式记录接替。
- 招商银行本账期日度交易可在账单生成前查看；正式账单入库后会与已同步的未出账明细衔接。
- 首页和账单页提供每月账单金额走势；本期应还、待还笔数和未来事项分别统计展示。

### 年费识别、预告与显著提醒

- 从交易明细识别实际年费金额，并按真实交易卡归属年费；年费交易会在账单与交易明细中单独标记。
- 可从历史年费交易自动识别卡片年费日，也可手动设置且手动设置不会被后续自动识别覆盖。
- 在年费即将计入下一期账单前，根据年费日和上一期账单还款日生成提前提醒。
- 新账单出现尚未处理的实际年费时，首页显示独立的高优先级年费提醒，按银行与币种汇总金额，可查看涉及的卡片、账期和交易明细。
- 年费显著提醒可单独确认；对应账单已部分还款或已还清后不再继续显示。

### 自定义提醒与丰富周期

| 类型 | 适用场景 | 处理方式 |
| --- | --- | --- |
| 常规提醒 | 证件到期、会员续费、纪念日、定期检查等非账单事项 | 到期后标记「完成」 |
| 固定账单 | 房租、宽带、保险等每期金额固定的账单 | 预设固定金额，按期进入账单台账并标记还款 |
| 动态账单 | 水电燃气、物业费等每期金额变化的账单 | 每期还款时填写实际金额，并保留该期记录 |

- 三类提醒都支持单次、按天、按周、按月和按年；循环周期可设置为每 N 天、N 周、N 月或 N 年。
- 按周可指定星期；按月可选择 1–28 日、月末当天、月末前 1 天或月末前 2 天；按年可指定月份和日期。
- 可同时选择多个提前提醒时间，并在保存前预览接下来 3 个提醒或还款日期。
- 每项提醒支持名称、备注、启用/停用；停用时可选择保留当前未处理事项，或同时将其隐藏。
- 常规提醒、固定账单和动态账单会生成独立期次，不会因为修改后续周期而丢失已经完成或已还的历史记录。

### 今日待办、未来日程与统一提醒

- 信用卡还款、信用卡出账、年费、常规提醒、固定账单和动态账单统一进入同一个提醒结果流，不按来源拆成互相独立的系统。
- 首页「今日待办」集中展示当天及临近到期的未处理事项，逾期事项优先；可直接完成提醒、标记信用卡还款或登记自定义账单还款。
- 「未来 14 天」展示即将到来的出账日、还款日、年费和自定义事项；提醒中心还可查看更长周期的未来安排。
- 卡片冻结或注销、账单已经还清、自定义提醒停用等状态会同步影响后续提醒，不继续生成无效事项。

### 多渠道推送与自动任务

- 内置 Bark、ntfy、Gotify、Telegram Bot、Server酱、PushPlus、企业微信机器人、钉钉机器人和飞书机器人；还可配置自定义 HTTP 推送。
- 可在安装向导一次选择多个渠道，也可在系统设置中分别绑定、启用、停用、移除和发送测试通知。所有启用渠道会同时收到当天提醒。
- 自定义 HTTP 推送默认只需填写请求方法、URL 和基础参数；展开高级设置后可配置查询参数、请求头、JSON/表单/纯文本正文及模板。模板支持 `{{title}}`、`{{body}}`、`{{group}}`、`{{count}}`、`{{appName}}` 占位符，不执行用户脚本。
- 通知渠道配置使用 `ENCRYPTION_KEY` 加密后保存；升级时首次读取会自动加密旧版明文渠道配置，并把旧 Bark 设置迁入新渠道表。
- 每天在配置的提醒时间先同步启用的邮箱，再汇总当天的还款、出账、年费和自定义提醒后推送；默认时间为上海时区 8:00。
- 同一渠道的多条当日提醒会合并为一条批量通知，减少连续打扰。
- 每个提醒按类型、业务记录、日期和通知渠道防重复；任务重复触发不会重复发送，失败的发送仍可在后续任务中重试。
- 提醒中心支持手动执行「立即推送今日提醒」，仍遵循同一天不重复发送的规则。

### 首页、跨设备与自托管

- 首页集中展示本期待还、未来 14 天事项、今日待办、年费显著提醒和最近 6 个月账单走势，各分区独立加载和失败重试。
- 同时适配电脑端与触屏端：桌面布局支持鼠标键盘操作，手机和平板使用触屏导航、单列信息流和大触控区域。
- 单管理员模式，首次访问通过 Web 安装向导设置管理员密码、可选 PIN 和通知渠道；安装完成后不会再次开放初始化入口。
- 支持官方 Docker 镜像、Docker 源码构建和 Node.js 源码部署，可选择内置 MySQL 或外置 MySQL。

## 界面预览与设备支持

本项目是响应式 Web 应用，无需安装原生客户端。电脑浏览器、手机和平板浏览器访问同一地址即可使用；桌面端会充分利用宽屏空间，触屏端会切换为适合手指操作的导航和信息布局。

| 使用设备 | 支持情况 | 交互形态 |
| --- | :---: | --- |
| 电脑端 | ✓ | 宽屏卡片/表格布局，适合鼠标与键盘 |
| 手机触屏端 | ✓ | 移动导航、单列信息流与大触控区域 |
| 平板触屏端 | ✓ | 根据可用宽度在移动与多列布局间自适应 |

### 卡片中心（电脑端）

![卡片中心电脑端效果图](./docs/images/card-center-desktop.png)

### 首页（触屏端）

![首页触屏端效果图](./docs/images/dashboard-touch.jpg)

## 支持的银行邮件与解析层级

解析器按已获得的银行邮件模板校准，并非对银行所有历史和未来格式的承诺。银行改版后可能需要新的版本化解析器。

- **账单摘要**：出账日/账单期、还款日、应还金额、最低还款额、币种和卡尾等，以邮件实际提供字段为准。
- **交易明细**：正式账单中的交易日期、摘要、金额、币种与卡尾等结构化数据。
- **未出账单日度明细**：尚未形成正式账单的本账期日度交易；当前仅招商银行「每日信用管家」支持。

| 银行 | 已校准模板 | 账单摘要 | 交易明细 | 未出账单日度明细 | 说明 |
| --- | --- | :---: | :---: | :---: | --- |
| 招商银行 | 2016 / 2020 / 2026 | ✓ | ✓ | ✓ | 2020/2026 账单支持明细；日度明细仅同步本账期，正式账单仍是还款和统计依据 |
| 中国工商银行 | 2026（含历史附件形态） | ✓ | ✓ | — | 支持正文或账单附件中的明细 |
| 中国农业银行 | 2019 / 2026 | ✓ | ✓ | — | 支持新旧发件域名和对账单格式 |
| 中国银行 | 2020 / 2026 | ✓ | ✓ | — | 支持邮件正文及 PDF 账单文本 |
| 中国建设银行 | 2026 | ✓ | ✓ | — | 支持多卡和原交易/入账币种信息 |
| 交通银行 | 2019 / 2026 | ✓ | ✓ | — | 支持人民币与美元账户 |
| 中信银行 | 2020 / 2023 / 2026 | ✓ | ✓ | — | 卡尾优先以交易明细中的四位卡尾为准 |
| 中国光大银行 | 2016 / 2017 / 2019 / 2026 | ✓ | ✓ | — | 支持多版本邮件/PDF 格式和多币种 |
| 华夏银行 | 2020 / 2026 | ✓ | ✓ | — | 支持人民币与美元账户 |
| 广发银行 | 2026 | ✓ | ✓ | — | 支持多卡与多币种明细 |
| 兴业银行 | 2026 | ✓ | ✓ | — | — |
| 平安银行 | 2019 / 2026 | ✓ | ✓ | — | 支持合并账单的多卡区块归属 |
| 浦发银行 | 2021 / 2026 | ✓ | — | — | 邮件只提供账单金额、最低还款额和日期等摘要；交易明细位于银行跳转页，访问时需要短信验证，因此无法自动抓取 |
| 中国民生银行 | 2026 | ✓ | ✓ | — | 支持人民币与美元账户 |
| 中国邮政储蓄银行 | 2022 / 2026 | ✓ | ✓ | — | 支持新旧发件域名 |
| 北京银行 | 2021 / 2026 | ✓ | ✓ | — | 现役模板支持合并账单明细 |
| 南京银行 | 2023 / 2026 | ✓ | ✓ | — | 2026 模板支持明细；2023 海报式历史模板为摘要级 |
| 湖南银行 | 2026（兼容华融湘江银行域名） | ✓ | ✓ | — | 支持合并账单多卡尾 |
| 湖南农信 | 2026 | ✓ | ✓ | — | 支持福祥信用卡电子账单 |
| 长沙银行 | 2026 | ✓ | ✓ | — | 支持合并账单多卡尾 |

一封邮件只有在发件人、标题和模板特征命中解析器后才会进入账单流程。不匹配的营销邮件不会被当成账单。

## 安全与数据边界

- 完整卡号、有效期和 CVV 使用「环境主密钥 + 用户 PIN」双密钥 AES-256-GCM 加密。
- PIN 不存储在后台；后台仅保存用于校验的随机盐和验证器。
- 邮件正文不入库；数据库保存邮件元数据和解析后的结构化账单/交易数据。
- IMAP 同步只读取新 UID，不会将银行邮件标记为已读。
- `ENCRYPTION_KEY` 一旦用于写入数据便不能更换，否则已有密文无法解密。
- 本项目不代替银行官方账单、还款通知或账户安全措施。

## 部署方式

推荐优先使用 AI 协助部署；也可以手动使用官方 Docker 镜像、从 Docker 源码构建，或完全不使用 Docker 进行源码部署。

## 方式一：使用 AI 协助部署（推荐）

一键复制以下提示词到任意 AI 工具即可：

```text
我希望部署「守候信用卡小管家」。请先完整阅读并严格遵循下面的 AI 部署提示词：
https://raw.githubusercontent.com/kukushouhou/card-bill-assistant/main/AI_DEPLOYMENT_PROMPT.md

项目仓库：
https://github.com/kukushouhou/card-bill-assistant

阅读后请不要立即执行部署。先按照部署提示词询问我尚未提供的必要信息，为每项选择给出推荐默认值并说明影响；待方案确认后，再指导我完成环境变量配置、Docker Compose 启动、健康检查和备份。涉及密码、密钥或完整数据库连接串时，请提示安全风险并推荐优先在目标设备本地填写；是否在对话中提供由我自行决定。
```

## 方式二：手动使用官方 Docker 镜像

### 图形化 Docker 管理界面

适用于任何支持粘贴或导入 Docker Compose YAML 的图形化管理界面。点击下面的链接进入源文件页面，使用页面右上角的复制按钮复制全部内容，再粘贴到新建项目、Stack 或编排任务中：

- **内置 MySQL：** [打开并复制 docker-compose.yml](./docker-compose.yml)
- **外置 MySQL：** [打开并复制 docker-compose.external.yml](./docker-compose.external.yml)
- **环境变量：** [打开并复制 .env.docker.example](./.env.docker.example)

### 命令行部署

#### 前置条件

- 64 位 `amd64` 或 `arm64` 主机。
- Docker Engine 与 Docker Compose v2。
- 内置模式使用项目提供的 MySQL 8.4；外置模式需要已创建的 MySQL 数据库及建表权限。

#### 方案 A：内置 MySQL

使用 [docker-compose.yml](./docker-compose.yml)，点击链接可直接查看或复制完整配置。

先克隆 `v0.2.0` 的部署文件：

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/kukushouhou/card-bill-assistant.git
cd card-bill-assistant
```

Linux/NAS（内置 MySQL）：

```bash
sh ./scripts/gen-env.sh
docker compose pull
docker compose up -d
```

Windows PowerShell（内置 MySQL）：

```powershell
pwsh ./scripts/gen-env.ps1
docker compose pull
docker compose up -d
```

该方案会启动应用与 MySQL 两个容器，数据保存在 `db-data` Docker 卷中。MySQL 没有对宿主机暴露端口。

#### 方案 B：外置 MySQL

使用 [docker-compose.external.yml](./docker-compose.external.yml)，点击链接可直接查看或复制完整配置。

Linux/NAS：

```bash
sh ./scripts/gen-env.sh --external
# 在目标主机本地编辑 .env 中的 DATABASE_URL
docker compose -f docker-compose.external.yml pull
docker compose -f docker-compose.external.yml up -d
```

Windows PowerShell：

```powershell
pwsh ./scripts/gen-env.ps1 -External
# 在目标主机本地编辑 .env 中的 DATABASE_URL
docker compose -f docker-compose.external.yml pull
docker compose -f docker-compose.external.yml up -d
```

MySQL 密码中的特殊字符必须进行 URL 编码。例如 `@` 为 `%40`、`&` 为 `%26`、`#` 为 `%23`。

### 关键环境变量

| 变量 | 必填 | 默认值 | 用途 |
| --- | :---: | --- | --- |
| `APP_VERSION` | 否 | `0.2.0` | GHCR 镜像版本；生产环境建议固定版本 |
| `DATABASE_URL` | 外置模式 | 无 | MySQL 连接串 |
| `MYSQL_ROOT_PASSWORD` | 内置模式 | 脚本随机生成 | MySQL root 密码 |
| `MYSQL_PASSWORD` | 内置模式 | 脚本随机生成 | 应用数据库账号密码 |
| `ENCRYPTION_KEY` | 是 | 脚本随机生成 | 邮箱授权码、通知渠道配置和卡信息的环境主密钥，不可更换 |
| `JWT_SECRET` | 是 | 脚本随机生成 | 登录会话签名 |
| `COOKIE_SECURE` | 否 | `true` | HTTPS 部署保持 `true`；仅局域网纯 HTTP 部署才设 `false` |
| `APP_BIND_IP` | 否 | `0.0.0.0` | 宿主机绑定地址 |
| `APP_PORT` | 否 | `3000` | 宿主机访问端口 |
| `APP_NAME` | 否 | 守候信用卡小管家 | 登录页、导航栏、页面标题和通知名称 |
| `REMINDER_HOUR` | 否 | `8` | 上海时区每日提醒小时（0–23） |
| `BARK_URL` | 否 | 空 | 旧版 Bark 环境变量兼容入口；推荐在 Web 安装向导或系统设置中配置渠道 |

启动脚本默认不覆盖已有 `.env`。升级或迁移时必须保留原来的 `ENCRYPTION_KEY`。

## 方式三：使用 Docker 从源码构建

需要审阅、修改源码或自行生成本地镜像时，在对应数据库编排上叠加 [docker-compose.build.yml](./docker-compose.build.yml)：

```bash
# 内置 MySQL
sh ./scripts/gen-env.sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

# 外置 MySQL
sh ./scripts/gen-env.sh --external
# 在目标主机本地编辑 .env 中的 DATABASE_URL
docker compose -f docker-compose.external.yml -f docker-compose.build.yml up -d --build
```

本地构建镜像名为 `card-bill-assistant:local`，不会覆盖官方 GHCR 镜像。

## 方式四：手动源码部署（不使用 Docker）

适合已经自行维护 Node.js 进程、MySQL、HTTPS 反向代理和系统服务的环境。需要 Node.js 24 与 MySQL 8：

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/kukushouhou/card-bill-assistant.git
cd card-bill-assistant

cd web
npm ci
npm run build

cd ../server
cp ../.env.example .env
# 在本机编辑 server/.env，至少填写 DATABASE_URL、ENCRYPTION_KEY、JWT_SECRET
# 通过 HTTPS 部署时将 COOKIE_SECURE 改为 true
npm ci --omit=dev
npx prisma generate
npx prisma migrate deploy
NODE_ENV=production npm start
```

服务端会直接托管 `web/dist`，默认监听 `3000` 端口。生产环境应使用 systemd、Supervisor 或 NAS 套件守护进程，并通过 HTTPS 反向代理访问。Windows PowerShell 可将最后一行改为 `$env:NODE_ENV='production'; npm start`。完整的升级、服务守护与备份说明见 [DEPLOY.md](./DEPLOY.md)。

### HTTPS 与登录 Cookie

Docker 默认 `COOKIE_SECURE=true`。请在 NAS 或网关中将 HTTPS 域名反向代理到应用端口。如果只在受信任的局域网使用纯 HTTP，需要显式设置：

```env
COOKIE_SECURE=false
```

纯 HTTP 不提供传输加密，不建议用于无线公共网络或任何公网环境。

### 首次安装

访问应用地址后，Web 向导会依次完成：

1. 数据库环境检查。
2. 设置内置 `admin` 管理员密码和可选的六位 PIN。
3. 选择并配置一个或多个通知渠道，也可暂时跳过。
4. 完成安装并登录。

安装完成后 `POST /api/setup/install` 会永久拒绝再次安装。

### 健康检查与日志

```bash
docker compose ps
docker compose logs --tail=200 app
curl -fsS http://127.0.0.1:3000/api/health
```

如果修改了 `APP_PORT`，请在健康检查中使用实际端口。Compose 已为应用和 MySQL 配置日志轮转。

更完整的备份、升级和运维命令见 [DEPLOY.md](./DEPLOY.md)。

## 本地开发

环境要求：Node.js 24+ 与 MySQL 8。

```bash
# 后端
cd server
npm install
npx prisma generate
npx prisma migrate deploy
npm run dev

# 前端（另一个终端）
cd web
npm install
npm run dev
```

开发环境后端默认为 `http://localhost:3000`，前端为 `http://localhost:5173`。Vite 会将 `/api` 代理到后端。

提交前验证：

```bash
cd server
npm test
npm run typecheck

cd ../web
npm run build
```

## 新增银行解析器

1. 在 `server/src/parsers/banks/` 新建「银行拼音-校准年份」文件。
2. 实现解析器接口，以发件人和账单标题建立白名单。
3. 在 `server/src/parsers/registry.ts` 注册，新模板优先级高于历史模板。
4. 增加脱敏样本测试，确保失败时可回退历史解析器。
5. 不要提交真实邮件原文、持卡人姓名、完整卡号、邮箱授权码或本地 `.env`。

## 技术栈

- 后端：Node.js 24、Express 5、Prisma 7、MySQL、Vitest。
- 前端：React 19、Vite 8、Ant Design 6、Ant Design Mobile、`@ant-design/plots`。
- 部署：Docker 多阶段构建、Docker Compose、内置/外置 MySQL 双模式。

## 许可证

本项目使用 [MIT License](./LICENSE)。

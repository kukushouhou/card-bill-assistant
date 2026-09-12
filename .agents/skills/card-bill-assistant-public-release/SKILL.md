---
name: card-bill-assistant-public-release
description: Publish an authorized version of the card-bill-assistant project with complete Chinese release notes, synchronized version files, remote CI, GitHub Release, and verified multi-platform GHCR images. Use when the user asks to release, publish, tag, or prepare a version of this repository; do not use for ordinary local development.
---

# 信用卡小管家公开发布

Only mutate GitHub, tags, Releases, or GHCR after the user has explicitly authorized publication. A request such as “提交并发布 0.3.1” provides that authority for the named version; local development alone does not.

## Establish the release

1. Read `RELEASING.md`, `.github/workflows/ci.yml`, `.github/workflows/container-release.yml`, the latest `docs/releases/vX.Y.Z.md`, and the complete diff since the previous stable tag.
2. Confirm the requested semantic version, previous tag, branch, remote, working tree, and GitHub authentication. Never expose credentials.
3. Treat publication as incomplete until the pushed commit, `main` CI, version tag, GitHub Release, GHCR tags, and dual-platform OCI manifest are all verified.

## Ship the whole working tree (no partial commits)

1. The release commit must include **every** modified, added, renamed, and deleted file present in the working tree at release time. Partial staging, hunk splitting, and excluding changes as "belonging to another effort" are forbidden — a release that ships only part of the working tree is a failed release.
2. If the ownership or readiness of any working-tree change is unclear, ask the user and wait for the answer before staging anything. Never resolve that question by silently leaving changes out.
3. Local-only debris is not work product: delete temporary scripts, logs, and debug dumps, and ignore local tool session state via `.gitignore` (following the repository's existing local-AI-artifact conventions). State every such cleanup item in the delivery report.
4. Before committing, re-run `git status` and reconcile it against the staged file list; after committing, `git status` must be clean of product changes.

## Write the Chinese release notes

Create `docs/releases/vX.Y.Z.md` before committing. Never substitute generated commit titles for a real changelog. Include the release date, previous version, Compare link, and exactly these required headings:

- `## 版本概述`: 两三句话说清这次更新给用户带来了什么。
- `## 详细变更`: 按主题列出用户可感知的变化，区分新功能与问题修复。
- `## 升级说明`: 只写用户需要动手或会注意到的事：备份数据、镜像版本号、升级后界面或数据有什么变化、需要做什么选择；用一句话说明有无数据迁移。
- `## Docker 镜像`: list the immutable version tag, minor tag, `latest`, Compose choices, and `linux/amd64` plus `linux/arm64`.
- `## 验证结果`: report tests, type checks, production build, Compose or Docker checks, representative routes, and remote CI. Do not claim checks that were not run.

### 写作红线（硬性限制，违反任何一条即不合格，必须重写）

发布说明的唯一读者是使用这个软件管理信用卡账单的普通用户，不是开发者。动笔前与完稿后逐条自检：

1. **只写用户可感知的变化**：能用什么新功能、什么问题不再出现、哪个操作变了、升级后会看到什么。
2. **禁止出现任何系统实现细节**：模块、函数、数据结构、字段名、解析器机制、匹配逻辑、归组算法、迁移游标、事务、前端组件与 CSS 等实现词汇一律不得出现。只允许写界面上的中文词（如「卡片颜色」「年费收取日」）。
3. **禁止「已知限制」类内容**：不设该章节，也不在任何章节写「仍存在的限制」「既有限制继续适用」之类的兜底话——用户既不关心也无法据此行动。
4. **禁止 AI 味套话**：不写空洞总结（如「本版本包含三条主线」）、自我评价（如「语义正确」「彻底消除」）、排比式小标题堆砌与重复铺垫。每句话都要有用户能感知或能行动的信息，否则删掉。
5. **修复不写成技术复盘**：用户只在意「什么问题不再发生」，不写根因分析、调用链、判定矩阵、覆盖用例清单。
6. 宁可短而实，不可长而虚：一条变化一两句话说清，多分条、不堆段。

Do not disclose real card numbers, account data, secrets, or internal-only test fixtures.

## Synchronize the version

Update every project-owned version reference, including:

- `server/package.json`, `server/package-lock.json`, `web/package.json`, and `web/package-lock.json`;
- `docker-compose.yml`, `docker-compose.external.yml`, and `.env.docker.example`;
- `scripts/gen-env.ps1`, `scripts/gen-env.sh`, `README.md`, `DEPLOY.md`, and `AI_DEPLOYMENT_PROMPT.md`;
- the new release note and any current-version links.

Search again for the previous version. Ignore historical release notes and third-party dependency versions, but investigate every remaining project-owned match.

## Verify before delivery

Use the repository testing discipline and leave no temporary logs behind. At minimum run:

- all server tests and the server TypeScript check;
- all Web interaction/component tests, Web TypeScript check, and production build;
- `git diff --check` and the skill validator;
- Compose configuration and production Docker image checks when Docker is available;
- `/api/health`, `/`, and `/login`, requiring HTML for the two Web routes.

If local Docker is unavailable, say so and rely on the repository’s Docker CI job; never represent it as a local pass. Review the staged diff for release-note accuracy, version consistency, sensitive files, and unintended scope.

## Publish and wait

1. Commit the complete release as one traceable release commit and push `main`.
2. Wait for every CI job for that commit to succeed. Do not tag a failing or still-running commit.
3. Create and push the exact `vX.Y.Z` tag only after `main` CI succeeds.
4. Wait for the tag-triggered container workflow. It must publish the image before creating or updating the GitHub Release.
5. Verify the GitHub Release title and body, GHCR tags `X.Y.Z`, `X.Y`, and `latest`, and an OCI manifest containing both `linux/amd64` and `linux/arm64`.
6. Report commit SHA, tag, workflow URLs or run IDs, Release URL, image tags, digest, platforms, migration status, and any blocked checks.

Do not call the release complete merely because local files, a commit, or a tag exist. Continue until the public artifacts are verified or report the specific external blocker.

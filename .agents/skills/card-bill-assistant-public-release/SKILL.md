---
name: card-bill-assistant-public-release
description: Publish an authorized version of the card-bill-assistant project with complete Chinese release notes, synchronized version files, remote CI, GitHub Release, and verified multi-platform GHCR images. Use when the user asks to release, publish, tag, or prepare a version of this repository; do not use for ordinary local development.
---

# 信用卡小管家公开发布

Only mutate GitHub, tags, Releases, or GHCR after the user has explicitly authorized publication. A request such as “提交并发布 0.3.1” provides that authority for the named version; local development alone does not.

## Establish the release

1. Read `RELEASING.md`, `.github/workflows/ci.yml`, `.github/workflows/container-release.yml`, the latest `docs/releases/vX.Y.Z.md`, and the complete diff since the previous stable tag.
2. Confirm the requested semantic version, previous tag, branch, remote, working tree, and GitHub authentication. Preserve unrelated user changes and never expose credentials.
3. Treat publication as incomplete until the pushed commit, `main` CI, version tag, GitHub Release, GHCR tags, and dual-platform OCI manifest are all verified.

## Write the Chinese release notes

Create `docs/releases/vX.Y.Z.md` before committing. Never substitute generated commit titles for a real changelog. Include the release date, previous version, Compare link, and exactly these required headings:

- `## 版本概述`: explain the user problem solved and the release positioning.
- `## 详细变更`: describe observable product, interface, deployment, and documentation changes by topic. Use user language and distinguish fixes from new capabilities.
- `## 升级说明`: state retained configuration and data, incompatible changes, database migrations, reprocessing requirements, and rollback or backup considerations. Explicitly say when no migration or reprocessing exists.
- `## Docker 镜像`: list the immutable version tag, minor tag, `latest`, Compose choices, and `linux/amd64` plus `linux/arm64`.
- `## 验证结果`: report tests, type checks, production build, Compose or Docker checks, representative routes, and remote CI. Do not claim checks that were not run.
- `## 已知限制`: preserve still-relevant limitations and state whether this release adds any new limitation.

Keep the notes complete but readable. Do not disclose real card numbers, account data, secrets, or internal-only test fixtures.

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

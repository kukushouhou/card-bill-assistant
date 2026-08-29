# ===== 阶段 1：构建前端 =====
FROM node:24-alpine AS web-build
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ===== 阶段 2：服务端 + 前端产物 =====
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai

# 先装依赖（利用层缓存）
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 源码 + Prisma
COPY server/ ./
# generate 只需要格式有效的数据源配置，不会连接该构建期占位数据库
RUN DATABASE_URL=mysql://build:build@127.0.0.1:3306/build ./node_modules/.bin/prisma generate

# 前端产物
COPY --from=web-build /build/dist /app/web/dist

EXPOSE 3000
# 启动前自动执行数据库迁移
USER node
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx src/index.ts"]

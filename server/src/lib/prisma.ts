import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';
import { config } from '../config';
import { parseMysqlUrl } from './database-url';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaMariaDb({
      ...parseMysqlUrl(config.databaseUrl),
      // 私人自托管场景访问间隔常以天计。连接器默认 minimumIdle=connectionLimit 会让空闲连接
      // 永不回收、又无 TCP 保活，长时间闲置后池里全是已被服务端/NAT 断掉的连接，
      // 首次访问的并发请求会随机命中死连接报「服务器内部错误」。
      minimumIdle: 1,
      idleTimeout: 120,
      keepAliveDelay: 30_000,
      connectTimeout: 10_000,
    }),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

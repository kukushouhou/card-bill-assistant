import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';
import { config } from '../config';

function parseMysqlUrl(url: string) {
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, '');
  if (!u.hostname || !db) throw new Error('DATABASE_URL 格式非法，应为 mysql://user:pass@host:3306/dbname');
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: db,
    connectionLimit: 10,
  };
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaMariaDb(parseMysqlUrl(config.databaseUrl)),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

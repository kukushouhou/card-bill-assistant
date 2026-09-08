import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';
import { config } from '../config';
import { parseMysqlUrl } from './database-url';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaMariaDb(parseMysqlUrl(config.databaseUrl)),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

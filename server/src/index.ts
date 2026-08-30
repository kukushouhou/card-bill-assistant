import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { ApiError, formatValidationIssues } from './lib/errors';
import { prisma } from './lib/prisma';
import { recomputePrimary } from './lib/card-groups';
import { startScheduler } from './jobs/scheduler';
import { materializeCustomReminderOccurrences } from './modules/reminders/custom-occurrences';
import setupRoutes from './routes/setup.routes';
import authRoutes from './routes/auth.routes';
import cardsRoutes from './routes/cards.routes';
import billsRoutes from './routes/bills.routes';
import remindersRoutes from './routes/reminders.routes';
import dashboardRoutes from './routes/dashboard.routes';
import emailRoutes from './routes/email.routes';
import jobsRoutes from './routes/jobs.routes';
import settingsRoutes from './routes/settings.routes';
import transactionsRoutes from './routes/transactions.routes';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // 健康检查
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // 应用信息（免认证：登录页/安装向导需在登录前显示应用名）
  app.get('/api/app', (_req, res) => {
    res.json({ name: config.appName });
  });

  // API 路由（setup 免认证，须在最前）
  app.use('/api/setup', setupRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/cards', cardsRoutes);
  app.use('/api/bills', billsRoutes);
  app.use('/api/reminders', remindersRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/email', emailRoutes);
  app.use('/api/jobs', jobsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/transactions', transactionsRoutes);

  // 前端静态资源（生产模式）
  const dist = config.webDistDir;
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    // SPA 兜底：非 /api 路径回退 index.html
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `路径不存在: ${req.method} ${req.path}` });
  });

  // 统一错误处理
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // zod 校验错误
    if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
      const issues = (err as { issues: Array<{ code?: string; message: string }> }).issues;
      res.status(400).json({ error: formatValidationIssues(issues) });
      return;
    }
    console.error('[http] 未处理异常:', err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  // 初始化：打印安装状态（未安装时由前端安装向导引导完成）
  const installedAt = await prisma.appSetting
    .findUnique({ where: { key: 'installedAt' } })
    .then((r) => r?.value ?? null)
    .catch(() => null);
  if (installedAt) {
    console.log(`[setup] 系统已安装（${installedAt}）`);
    // 启动时按套卡归组标记优先显示卡（手动指定优先，自动推导不覆盖）
    await recomputePrimary().catch((err) => console.error('[cards] 优先显示重算失败:', err));
    // 补齐停机期间已经到最早提醒日的自定义提醒期次。
    await materializeCustomReminderOccurrences().catch((err) => console.error('[reminders] 自定义提醒期次补齐失败:', err));
  } else {
    console.log('[setup] 系统未安装：请访问 Web 页面，按安装向导设置管理员密码');
  }
  startScheduler();

  app.listen(config.port, () => {
    console.log(`[server] 守候信用卡小管家已启动: http://localhost:${config.port}`);
    console.log(`[server] 前端目录: ${fs.existsSync(dist) ? dist : '(未构建，仅 API 模式)'}`);
  });
}

main()
  .catch((err) => {
    console.error('[server] 启动失败:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // 开发模式下由 tsx watch 管理进程生命周期；生产模式下显式断开
    process.on('SIGINT', async () => {
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
  });

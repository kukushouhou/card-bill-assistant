import type { RequestHandler } from 'express';

/** 在读请求正文前拦截跨站写入，同时兼容同源反向代理和非浏览器客户端。 */
export const apiSecurity: RequestHandler = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.get('Sec-Fetch-Site');
  if (site === 'cross-site' || site === 'same-site') {
    res.status(403).json({ error: '不允许跨站提交请求' });
    return;
  }
  const origin = req.get('Origin');
  if (origin && site !== 'same-origin') {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.get('Host')) throw new Error();
    } catch {
      res.status(403).json({ error: '不允许跨站提交请求' });
      return;
    }
  }
  next();
};

/** 不限制现有皮肤、图表和内联样式；禁止第三方页面嵌套应用和插件执行。 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  });
  next();
};

/** 按实际连接来源限流，不信任客户端伪造的转发头；有界存储避免攻击者撑大内存。 */
export function attemptLimit(max: number, windowMs = 15 * 60_000, options: { countSuccess?: boolean } = {}): RequestHandler {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const capacity = 2_048;
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    for (const [address, entry] of attempts) if (entry.resetAt <= now) attempts.delete(address);
    let entry = attempts.get(key);
    if (!entry && attempts.size < capacity) {
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(key, entry);
    }
    if (!entry || entry.count >= max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(((entry?.resetAt ?? now + windowMs) - now) / 1_000))));
      res.status(429).json({ error: '尝试次数过多，请稍后再试' });
      return;
    }
    entry.count++;
    const reserved = entry;
    res.once('finish', () => {
      // 成功操作和服务器故障不占用失败额度；并发请求只释放自己的预占。
      if ((!options.countSuccess && res.statusCode < 400) || res.statusCode >= 500) reserved.count = Math.max(0, reserved.count - 1);
    });
    next();
  };
}

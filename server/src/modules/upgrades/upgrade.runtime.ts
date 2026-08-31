import type { NextFunction, Request, Response } from 'express';

export type UpgradeRuntimeMode = 'ready' | 'required_wait' | 'optional_wait' | 'executing' | 'failed';

export interface UpgradeRuntimeState {
  mode: UpgradeRuntimeMode;
  planId: number | null;
  message: string | null;
}

let runtimeState: UpgradeRuntimeState = { mode: 'ready', planId: null, message: null };
let activeBusinessWrites = 0;
const idleWaiters = new Set<() => void>();

export function getUpgradeRuntimeState(): UpgradeRuntimeState {
  return { ...runtimeState };
}

export function setUpgradeRuntimeState(next: UpgradeRuntimeState): void {
  runtimeState = { ...next };
}

function releaseBusinessWrite(): void {
  activeBusinessWrites = Math.max(0, activeBusinessWrites - 1);
  if (activeBusinessWrites === 0) {
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }
}

/** 升级执行前等待已进入的业务写请求完成。 */
export async function waitForBusinessWrites(): Promise<void> {
  if (activeBusinessWrites === 0) return;
  await new Promise<void>((resolve) => idleWaiters.add(resolve));
}

const IMPLICIT_WRITE_GET_PREFIXES = ['/bills', '/dashboard', '/reminders'];

/**
 * 挂载在业务 API 之前：可选迁移等待期间正常放行；必选等待和执行期间禁止写入及隐式写入查询。
 */
export function upgradeBusinessGate(req: Request, res: Response, next: NextFunction): void {
  const writeLike = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    || IMPLICIT_WRITE_GET_PREFIXES.some((prefix) => req.path.startsWith(prefix));
  const blocked = ['required_wait', 'executing', 'failed'].includes(runtimeState.mode);
  if (blocked && writeLike) {
    res.status(503).json({ error: '系统正在处理版本升级，完成后即可继续操作' });
    return;
  }
  if (!writeLike) {
    next();
    return;
  }
  activeBusinessWrites++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseBusinessWrite();
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

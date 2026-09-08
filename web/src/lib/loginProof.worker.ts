import { findLoginProof, type WorkInput } from './loginProof.solver';

const worker = self as unknown as Pick<Worker, 'onmessage' | 'postMessage'>;
worker.onmessage = (event: MessageEvent<WorkInput>) => {
  try { worker.postMessage({ counter: findLoginProof(event.data) }); }
  catch { worker.postMessage({ error: '安全验证未完成，请重试' }); }
};

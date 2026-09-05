export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  // 401 只表示未登录/登录过期；登录接口豁免，避免密码错误也跳走
  if (resp.status === 401 && !path.includes('/auth/login')) {
    if (window.location.pathname !== '/login') window.location.assign('/login');
    throw new ApiError(401, '登录已过期');
  }
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    throw new ApiError(resp.status, data.error || `请求失败 (${resp.status})`);
  }
  return data as T;
}

export const api = {
  upload: <T>(path: string, body: Blob) => request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body }),
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body !== undefined ? JSON.stringify(body) : undefined }),
};

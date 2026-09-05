import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/** 保存已成功读取的内容；旧范围的晚到响应不能覆盖新范围。 */
export function useResource<T>(url: string | null, revision = 0) {
  const [state, setState] = useState<{ url: string | null; data?: T; error?: string; loading: boolean }>({ url, loading: !!url });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!url) return;
    setState(old => ({ url, data: old.url === url ? old.data : undefined, loading: true }));
    try {
      const data = await api.get<T>(url);
      if (current === generation.current) setState({ url, data, loading: false });
    } catch (reason) {
      if (current === generation.current) setState(old => ({ ...old, loading: false, error: reason instanceof Error ? reason.message : '暂时无法加载，请重试' }));
    }
  }, [url, revision]);
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [refresh]);
  return { data: state.url === url ? state.data : undefined, error: state.url === url ? state.error : undefined, loading: state.url !== url || state.loading, refresh };
}

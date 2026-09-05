import { useCallback, useRef, useSyncExternalStore, type SetStateAction } from 'react';

/** 只保存非敏感浏览状态；来源、筛选与分页各自独立。 */
const states = new Map<string, unknown>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useViewState<T>(key: string, initial: T | (() => T)) {
  const initializer = useRef(initial); initializer.current = initial;
  const get = useCallback(() => {
    if (!states.has(key)) states.set(key, typeof initializer.current === 'function' ? (initializer.current as () => T)() : initializer.current);
    return states.get(key) as T;
  }, [key]);
  const value = useSyncExternalStore(subscribe, get, get);
  const setValue = useCallback((action: SetStateAction<T>) => {
    states.set(key, typeof action === 'function' ? (action as (current: T) => T)(get()) : action);
    listeners.forEach(listener => listener());
  }, [key, get]);
  return [value, setValue] as const;
}
export function clearViewState() { states.clear(); listeners.forEach(listener => listener()); }

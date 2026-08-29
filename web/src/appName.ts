import { createContext, useContext } from 'react';

/** 应用名默认值（与后端 DEFAULT_APP_NAME 一致，接口返回前兜底显示） */
export const DEFAULT_APP_NAME = '守候信用卡小管家';

/** 应用名 Context：App.tsx 启动时从 GET /api/app 加载（APP_NAME 环境变量可自定义） */
export const AppNameContext = createContext(DEFAULT_APP_NAME);

export function useAppName(): string {
  return useContext(AppNameContext);
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import 'antd-mobile/es/global';
import './index.css';

dayjs.locale('zh-cn');

// 禁止页面缩放，但不干扰单指滚动与下拉刷新。
const preventMultiTouchZoom = (event: TouchEvent) => {
  if (event.touches.length > 1) event.preventDefault();
};
const preventGestureZoom = (event: Event) => event.preventDefault();

document.addEventListener('touchstart', preventMultiTouchZoom, { passive: false });
document.addEventListener('touchmove', preventMultiTouchZoom, { passive: false });
document.addEventListener('gesturestart', preventGestureZoom, { passive: false });
document.addEventListener('gesturechange', preventGestureZoom, { passive: false });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#2f54eb',
          colorBgLayout: '#f5f6fa',
          colorText: '#172033',
          colorTextSecondary: '#667085',
          colorBorderSecondary: '#e8ebf2',
          borderRadius: 10,
          borderRadiusLG: 14,
          controlHeight: 36,
          fontSize: 14,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          boxShadowTertiary: '0 4px 18px rgba(32, 44, 78, 0.07)',
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);

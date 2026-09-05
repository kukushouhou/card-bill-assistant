import React from 'react';
import { createRoot } from 'react-dom/client';
import SkinProvider from './skins/SkinProvider';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import 'antd-mobile/es/global';
import './index.css';

dayjs.locale('zh-cn');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SkinProvider><App /></SkinProvider>
  </React.StrictMode>,
);

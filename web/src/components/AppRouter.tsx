import { createContext, useContext, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';

const RouteContent = createContext<ReactNode>(null);
function CurrentRoutes() { return useContext(RouteContent); }
let router: ReturnType<typeof createBrowserRouter> | null = null;

/** 路由实例终身稳定，提供统一的未保存导航保护。 */
export default function AppRouter({ children }: { children: ReactNode }) {
  router ??= createBrowserRouter([{ path: '*', element: <CurrentRoutes /> }]);
  return <RouteContent.Provider value={children}><RouterProvider router={router} /></RouteContent.Provider>;
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './shell';
import { Overview } from './pages/Overview';
import { Clusters } from './pages/Clusters';
import { Resources } from './pages/Resources';
import { ResourceEditor } from './pages/ResourceEditor';
import { Drafts, Changes, ChangeDetail } from './pages/Changes';
import { PluginCatalog } from './pages/Plugins';
import { Accounts, Audit } from './pages/Access';
import { Managed } from './pages/Managed';
import { Transfer } from './pages/Transfer';
import { Diagnostics } from './pages/Diagnostics';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
// The shell stores a same-app return path when a protected link requires sign-in.
function LoginDestination() {
  const { state } = useLocation();
  const path = state?.returnTo;
  const localPath = typeof path === 'string' && /^\/(?!\/)/.test(path) && !/[\\\s]/.test(path);
  return <Navigate to={localPath ? path : '/'} replace />;
}
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'login', element: <LoginDestination /> },
      { path: 'clusters', element: <Clusters /> },
      { path: 'routes', element: <Resources kind="routes" /> },
      { path: 'routes/new', element: <ResourceEditor kind="routes" /> },
      { path: 'routes/:resourceId/edit', element: <ResourceEditor kind="routes" /> },
      { path: 'upstreams', element: <Resources kind="upstreams" /> },
      { path: 'upstreams/new', element: <ResourceEditor kind="upstreams" /> },
      { path: 'upstreams/:resourceId/edit', element: <ResourceEditor kind="upstreams" /> },
      { path: 'consumers', element: <Resources kind="consumers" /> },
      { path: 'consumers/new', element: <ResourceEditor kind="consumers" /> },
      { path: 'consumers/:resourceId/edit', element: <ResourceEditor kind="consumers" /> },
      { path: 'policies', element: <Managed policy /> },
      { path: 'extended', element: <Managed policy={false} /> },
      { path: 'transfer', element: <Transfer /> },
      { path: 'diagnostics', element: <Diagnostics /> },
      { path: 'plugins', element: <PluginCatalog /> },
      { path: 'drafts', element: <Drafts /> },
      { path: 'drafts/:draftId/edit', element: <ResourceEditor /> },
      { path: 'changes', element: <Changes /> },
      { path: 'changes/:changeId', element: <ChangeDetail /> },
      { path: 'users', element: <Accounts /> },
      { path: 'audit', element: <Audit /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);

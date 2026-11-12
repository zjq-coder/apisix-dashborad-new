import { useLocale, useTranslate } from './i18n';
import { useFeedback } from './i18n/feedback';
import { useLocaleForm } from './i18n/useLocaleForm';
import { LanguageSwitch } from './components/LanguageSwitch';
import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp,
  Avatar,
  Button,
  ConfigProvider,
  Alert,
  Dropdown,
  Form,
  Input,
  Select,
  Spin,
  Tag,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import {
  ApartmentOutlined,
  ApiOutlined,
  ArrowRightOutlined,
  AuditOutlined,
  BlockOutlined,
  CloudServerOutlined,
  AppstoreOutlined,
  FileTextOutlined,
  LogoutOutlined,
  MoonOutlined,
  RocketOutlined,
  SunOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DownOutlined,
} from '@ant-design/icons';
import {
  Navigate,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, post, setCSRF } from './api';
import { ConsoleContext } from './context';
import { consoleTheme } from './theme';
import { environmentNames, type Cluster, type Capability, type Session } from './types';

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const t = useTranslate();
  const feedback = useFeedback();
  const form = useLocaleForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="login-layout">
      <div className="login-story">
        <div className="wordmark">
          <ApiOutlined aria-hidden="true" /> APISIX <span>CONSOLE</span>
        </div>
        <div className="login-story-body">
          <div className="eyebrow">{t('网关运维')}</div>
          <h1>
            {t('每一次配置，')}
            <br />
            {t('都清楚可控。')}
          </h1>
          <p>
            {t('从路由匹配到上游转发，')}
            <br />
            {t('集中配置，一键发布。')}
            <br />
            {t('让网关管理回归简单。')}
          </p>
          <div className="login-flow">
            <span>{t('配置')}</span>
            <ArrowRightOutlined aria-hidden="true" />
            <span>{t('审查')}</span>
            <ArrowRightOutlined aria-hidden="true" />
            <span>{t('发布')}</span>
          </div>
        </div>
        <span className="login-footer">APISIX Dashboard Next · 0.1</span>
      </div>
      <div className="login-form">
        <div className="login-box">
          <div className="login-heading-row">
            <div className="eyebrow">{t('网关工作空间')}</div>
            <LanguageSwitch />
          </div>
          <h2>{t('欢迎回到控制台')}</h2>
          <p>{t('登录后继续管理你的网关与配置变更。')}</p>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ username: 'admin' }}
            onFinish={async (values) => {
              setBusy(true);
              setError('');
              try {
                const result = await post<Session>('/login', values);
                setCSRF(result.csrf_token);
                onLogin(result);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Form.Item
              name="username"
              label={t('用户名')}
              rules={[{ required: true, message: t('请输入用户名') }]}
            >
              <Input
                size="large"
                prefix={<UserOutlined aria-hidden="true" />}
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              label={t('密码')}
              rules={[{ required: true, message: t('请输入密码') }]}
            >
              <Input.Password size="large" autoComplete="current-password" />
            </Form.Item>
            {error && (
              <p className="error-text" role="alert">
                {feedback(error)}
              </p>
            )}
            <Button type="primary" htmlType="submit" size="large" block loading={busy}>
              {t('登录控制台')} <ArrowRightOutlined aria-hidden="true" />
            </Button>
          </Form>
          <div className="login-note">
            {t('本地初始化账户由部署配置提供。')}
            <br />
            {t('管理员可在项目的 .env 文件中查看登录信息。')}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const t = useTranslate();
  const feedback = useFeedback();
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('APISIX Console · 网关控制台');
  }, [locale, t]);
  const [dark, setDark] = useState(localStorage.getItem('console.theme') === 'dark');
  const [collapsed, setCollapsed] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const atLogin = useMatch('/login') !== null;
  const atConnections = useMatch('/clusters') !== null;
  const [explicitLogout, setExplicitLogout] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [params] = useSearchParams();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async ({ signal }) => {
      try {
        const result = await api<Session>('/session', { signal });
        signal.throwIfAborted();
        const old = client.getQueryData<Session | null>(['session']);
        if (old && old.csrf_token !== result.csrf_token)
          client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
        setCSRF(result.csrf_token);
        return result;
      } catch (err) {
        if ((err as { status: number }).status === 401) {
          setCSRF('');
          client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
          return null;
        }
        throw err;
      }
    },
    retry: false,
    refetchOnWindowFocus: 'always',
  });
  // A destination may already be in the browser cache. Check the session before showing it on navigation.
  const [verifiedPath, setVerifiedPath] = useState(location.pathname);
  const refetchSession = session.refetch;
  useEffect(() => {
    const path = location.pathname;
    if (path === verifiedPath) return;
    if (!session.data) {
      setVerifiedPath(path);
      return;
    }
    let active = true;
    void refetchSession().then(() => {
      if (active) setVerifiedPath(path);
    });
    return () => {
      active = false;
    };
  }, [location.pathname, verifiedPath, session.data?.username, refetchSession]);
  const clusters = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api<Cluster[]>('/clusters'),
    enabled: !!session.data,
  });
  const requestedCluster = params.get('cluster') || localStorage.getItem('console.cluster');
  const selected = clusters.data?.find((c) => c.id === requestedCluster) || clusters.data?.[0];
  const clusterId = selected?.id || '';
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('console.theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    if (clusterId) localStorage.setItem('console.cluster', clusterId);
    else if (clusters.data?.length === 0) localStorage.removeItem('console.cluster');
  }, [clusterId, clusters.data?.length]);
  const endSession = useCallback(
    (explicit: boolean) => {
      void client.cancelQueries({ queryKey: ['session'] });
      setCSRF('');
      setExplicitLogout(explicit);
      setLogoutError('');
      // Keep the observed session query attached while notifying the shell.
      client.setQueryData(['session'], null);
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      client.getMutationCache().clear();
    },
    [client],
  );
  useEffect(() => {
    const expired = () => endSession(false);
    window.addEventListener('session-expired', expired);
    const sync = (event: StorageEvent) => {
      if (event.key === 'console.auth-change') {
        if (event.newValue?.startsWith('logout:')) endSession(true);
        else void client.invalidateQueries({ queryKey: ['session'] });
      }
    };
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('session-expired', expired);
    };
  }, [client, endSession]);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError('');
    try {
      await post('/logout');
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setLogoutError((error as Error).message);
        return;
      }
    } finally {
      setSigningOut(false);
    }
    endSession(true);
    localStorage.setItem('console.auth-change', 'logout:' + Date.now());
  }
  const go = (path: string, id = clusterId) =>
    navigate(path + (id ? `${path.includes('?') ? '&' : '?'}cluster=${id}` : ''));
  const isAdmin = session.data?.role === 'administrator';
  const can = (cap: Capability, id = clusterId) =>
    isAdmin || !!session.data?.grants?.[id]?.includes(cap);
  const auditAccess =
    isAdmin || Object.values(session.data?.grants || {}).some((v) => v.includes('audit'));
  const allowedPage = (value: string) => {
    const path = value.toLowerCase().replace(/\/+$/, '');
    return !(
      (['/users', '/clusters'].includes(path) && !isAdmin) ||
      (path === '/audit' && !auditAccess)
    );
  };
  const groups = [
    {
      title: t('工作空间'),
      items: [{ path: '/', name: t('配置工作台'), icon: <AppstoreOutlined aria-hidden="true" /> }],
    },
    {
      title: t('网关配置'),
      items: [
        { path: '/routes', name: t('路由管理'), icon: <ApiOutlined aria-hidden="true" /> },
        { path: '/upstreams', name: t('上游管理'), icon: <ApartmentOutlined aria-hidden="true" /> },
        { path: '/consumers', name: t('消费者管理'), icon: <UserOutlined aria-hidden="true" /> },
        { path: '/policies', name: t('共享策略'), icon: <BlockOutlined /> },
        { path: '/extended', name: t('扩展资源'), icon: <ApartmentOutlined /> },
        { path: '/plugins', name: t('插件目录'), icon: <BlockOutlined aria-hidden="true" /> },
      ],
    },
    {
      title: t('变更管理'),
      items: [
        { path: '/transfer', name: t('环境迁移'), icon: <RocketOutlined /> },
        { path: '/diagnostics', name: t('配置诊断'), icon: <ApiOutlined /> },
        { path: '/drafts', name: t('草稿箱'), icon: <FileTextOutlined aria-hidden="true" /> },
        { path: '/changes', name: t('发布记录'), icon: <RocketOutlined aria-hidden="true" /> },
        { path: '/audit', name: t('操作审计'), icon: <AuditOutlined aria-hidden="true" /> },
      ],
    },
    {
      title: t('系统设置'),
      items: [
        {
          path: '/clusters',
          name: t('集群连接'),
          icon: <CloudServerOutlined aria-hidden="true" />,
        },
        { path: '/users', name: t('用户与权限'), icon: <UserOutlined aria-hidden="true" /> },
      ],
    },
  ]
    .map((g) => ({ ...g, items: g.items.filter((i) => allowedPage(i.path)) }))
    .filter((g) => g.items.length);
  const currentName =
    groups
      .flatMap((g) => g.items)
      .find((item) =>
        item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path),
      )?.name || t('配置编辑');
  return (
    <ConfigProvider locale={locale === 'en-US' ? enUS : zhCN} theme={consoleTheme(dark)}>
      <AntApp>
        {session.isLoading ? (
          <div className="full-loading">
            <Spin size="large" />
          </div>
        ) : session.error ? (
          <div className="full-loading">
            <LanguageSwitch />
            <p>{t('服务暂时不可用')}</p>
            <Button onClick={() => session.refetch()}>{t('重新连接')}</Button>
          </div>
        ) : !session.data && !atLogin ? (
          <Navigate
            to="/login"
            replace
            state={
              explicitLogout
                ? null
                : { returnTo: location.pathname + location.search + location.hash }
            }
          />
        ) : !session.data ? (
          <Login
            onLogin={(result) => {
              setExplicitLogout(false);
              void client.cancelQueries({ queryKey: ['session'] });
              client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
              client.setQueryData(['session'], result);
              localStorage.setItem('console.auth-change', String(Date.now()));
            }}
          />
        ) : atLogin ? (
          <Outlet />
        ) : (
          <ConsoleContext.Provider
            value={{
              isAdmin,
              can,
              username: session.data.username,
              cluster: selected,
              clusterId,
              clusters: clusters.data || [],
              dark,
              go,
              refresh: () => {
                client.invalidateQueries();
              },
            }}
          >
            <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
              <aside className="sidebar">
                <button
                  className="wordmark brand-button"
                  onClick={() => go('/')}
                  aria-label={t('返回配置工作台')}
                >
                  <span className="brand-symbol">
                    <ApiOutlined aria-hidden="true" />
                  </span>
                  <span className="brand-text">
                    APISIX <small>CONSOLE</small>
                  </span>
                </button>
                <div className="workspace-label">
                  <span className="workspace-avatar">
                    <CloudServerOutlined aria-hidden="true" />
                  </span>
                  <div>
                    <strong title={selected?.name}>{selected?.name || t('网关工作空间')}</strong>
                    <small>
                      <span className={`status-dot ${selected?.status || 'unchecked'}`} />
                      {selected ? t(environmentNames[selected.environment]) : t('等待接入集群')}
                    </small>
                  </div>
                </div>
                <nav aria-label={t('主导航')}>
                  {groups.map((group) => (
                    <div className="nav-group" key={group.title}>
                      <div className="nav-group-title">{group.title}</div>
                      {group.items.map((item) => {
                        const active =
                          item.path === '/'
                            ? location.pathname === '/'
                            : location.pathname.startsWith(item.path);
                        return (
                          <button
                            key={item.path}
                            aria-label={item.name}
                            title={item.name}
                            className={`nav-item ${active ? 'active' : ''}`}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => go(item.path)}
                          >
                            {item.icon}
                            <span>{item.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </nav>
                <div className="sidebar-bottom">
                  <span className="version-label">
                    Dashboard Next <b>0.1</b>
                  </span>
                  <p>{t('配置 · 审查 · 发布')}</p>
                </div>
              </aside>
              <div className="app-main">
                <header className="topbar">
                  <div className="breadcrumb">
                    <Button
                      type="text"
                      icon={
                        collapsed ? (
                          <MenuUnfoldOutlined aria-hidden="true" />
                        ) : (
                          <MenuFoldOutlined aria-hidden="true" />
                        )
                      }
                      aria-label={t('切换侧边栏')}
                      onClick={() => setCollapsed((v) => !v)}
                    />
                    <span className="breadcrumb-muted">{t('工作空间')}</span>
                    <span className="breadcrumb-separator">/</span>
                    <span>{currentName}</span>
                  </div>
                  <div className="topbar-actions">
                    <LanguageSwitch />
                    {selected && (
                      <Tag
                        color={
                          selected.environment === 'production'
                            ? 'orange'
                            : selected.environment === 'staging'
                              ? 'blue'
                              : 'default'
                        }
                      >
                        {t(environmentNames[selected.environment])}
                      </Tag>
                    )}
                    <Select
                      aria-label={t('当前集群')}
                      className="cluster-select"
                      getPopupContainer={(trigger) => trigger.parentElement!}
                      value={clusterId || undefined}
                      placeholder={t('选择集群')}
                      loading={clusters.isLoading}
                      options={(clusters.data || []).map((c) => ({ value: c.id, label: c.name }))}
                      onChange={(id) => {
                        const editing = /\/edit$|\/new$/.test(location.pathname);
                        go(editing ? '/routes' : location.pathname, id);
                      }}
                    />
                    <Button
                      type="text"
                      icon={
                        dark ? (
                          <SunOutlined aria-hidden="true" />
                        ) : (
                          <MoonOutlined aria-hidden="true" />
                        )
                      }
                      aria-label={t('切换颜色主题')}
                      onClick={() => setDark((v) => !v)}
                    />
                    <Dropdown
                      trigger={['click']}
                      getPopupContainer={(trigger) => trigger.parentElement!}
                      menu={{
                        items: [
                          {
                            key: 'user',
                            disabled: true,
                            label: session.data.username + ' · ' + t(isAdmin ? '管理员' : '成员'),
                          },
                          {
                            key: 'logout',
                            label: t('退出登录'),
                            icon: <LogoutOutlined aria-hidden="true" />,
                            disabled: signingOut,
                            onClick: signOut,
                          },
                        ],
                      }}
                    >
                      <button className="avatar-button" aria-label={t('账户菜单')}>
                        <Avatar size={32} className="account-avatar">
                          {session.data.username.slice(0, 1).toUpperCase()}
                        </Avatar>
                        <span className="account-name">
                          {session.data.username}
                          <small>{t(isAdmin ? '管理员' : '成员')}</small>
                        </span>
                        <DownOutlined aria-hidden="true" className="account-chevron" />
                      </button>
                    </Dropdown>
                  </div>
                </header>
                <main className="content">
                  {logoutError && (
                    <Alert
                      type="error"
                      showIcon
                      role="alert"
                      title={t('退出登录失败，请重试')}
                      description={feedback(logoutError)}
                    />
                  )}
                  {verifiedPath !== location.pathname ? (
                    <div className="full-loading">
                      <Spin />
                    </div>
                  ) : allowedPage(location.pathname) ? (
                    <Outlet
                      key={
                        atConnections ? session.data.username : session.data.username + clusterId
                      }
                    />
                  ) : (
                    <Alert type="warning" showIcon title={t('没有此操作的权限')} />
                  )}
                </main>
                <footer className="app-footer">
                  <span>{t('APISIX Console · 配置管理工作台')}</span>
                  <span>
                    {selected
                      ? `${selected.name}${selected.read_only ? t(' · 只读接入') : ''}`
                      : t('等待接入集群')}
                  </span>
                </footer>
              </div>
            </div>
          </ConsoleContext.Provider>
        )}
      </AntApp>
    </ConfigProvider>
  );
}

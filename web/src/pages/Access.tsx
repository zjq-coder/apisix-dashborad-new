import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import {
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useConsole } from '../context';
import { PageTitle, Panel, RequestError } from '../components/Common';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { useLocale, useTranslate } from '../i18n';
import { useFeedback } from '../i18n/feedback';
import {
  displayTime,
  environmentNames,
  type Capability,
  type Grants,
  type Session,
} from '../types';

type Account = Pick<Session, 'username' | 'role' | 'grants'> & {
  enabled: boolean;
  bootstrap: boolean;
  revision: number;
  created_at: string;
};
type AccountInput = {
  username: string;
  role: Session['role'];
  enabled: boolean;
  password?: string;
};
const capabilities: Record<Capability, string> = {
  edit: '编辑草稿',
  publish: '发布变更',
  rollback: '回退变更',
  audit: '查看审计',
};
const keys = Object.keys(capabilities) as Capability[];
export function Accounts() {
  const t = useTranslate(),
    feedback = useFeedback(),
    locale = useLocale();
  const { username, clusters, isAdmin } = useConsole();
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<Account[]>('/users'),
    enabled: isAdmin,
  });
  const [editing, setEditing] = useState<Account | null | undefined>();
  const [grants, setGrants] = useState<Grants>({});
  const [form] = Form.useForm<AccountInput>();
  const [search, setSearch] = useState('');
  const role = Form.useWatch('role', form);
  const [error, setError] = useState('');
  function open(a: Account | null) {
    setEditing(a);
    setError('');
    setGrants(a?.grants || {});
    form.resetFields();
    form.setFieldsValue({
      username: a?.username || '',
      role: a?.role || 'member',
      enabled: a?.enabled ?? true,
      password: '',
    });
  }
  function close() {
    form.resetFields();
    setEditing(undefined);
    setError('');
    setGrants({});
  }
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['accounts'] });
    void client.invalidateQueries({ queryKey: ['audit'] });
  };
  const save = useMutation({
    mutationFn: (v: AccountInput) =>
      api<Account>(editing ? '/users/' + encodeURIComponent(editing.username) : '/users', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...v,
          grants: v.role === 'administrator' ? {} : grants,
          revision: editing?.revision,
        }),
      }),
    onSuccess: () => {
      close();
      refresh();
      message.success(t('账号与权限已保存'));
    },
    onError: (e) => setError(e.message),
  });
  function remove(a: Account) {
    modal.confirm({
      title: t('删除账号 {0}？', a.username),
      content: t('登录会话将失效，已有操作记录会保留。'),
      okButtonProps: { danger: true },
      okText: t('删除账号'),
      cancelText: t('取消'),
      onOk: async () => {
        try {
          await api('/users/' + encodeURIComponent(a.username), {
            method: 'DELETE',
            body: JSON.stringify({ revision: a.revision }),
          });
          refresh();
        } catch (e) {
          message.error(feedback((e as Error).message));
          throw e;
        }
      },
    });
  }
  return (
    <>
      <PageTitle
        eyebrow={t('系统设置')}
        title={t('用户与权限')}
        description={t('为每位成员选择可访问的集群，分别授权编辑、发布、回退和审计。')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open(null)}>
            {t('添加账号')}
          </Button>
        }
      />
      <Panel
        title={
          <>
            <SafetyCertificateOutlined /> {t('控制台账号')}
          </>
        }
        extra={
          <Input.Search
            aria-label={t('搜索账号')}
            placeholder={t('搜索账号')}
            allowClear
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        {query.error ? (
          <RequestError error={query.error} />
        ) : (
          <Table<Account>
            rowKey="username"
            loading={query.isLoading}
            dataSource={(query.data || []).filter((v) =>
              v.username.toLowerCase().includes(search.trim().toLowerCase()),
            )}
            scroll={{ x: 810 }}
            columns={[
              {
                title: t('用户名'),
                dataIndex: 'username',
                render: (v: string, a) => (
                  <Space>
                    <UserOutlined />
                    <strong>{v}</strong>
                    {a.bootstrap && <Tag icon={<LockOutlined />}>{t('部署管理员')}</Tag>}
                  </Space>
                ),
              },
              {
                title: t('角色'),
                render: (_, a) => (
                  <Tag color={a.role === 'administrator' ? 'purple' : 'blue'}>
                    {t(a.role === 'administrator' ? '管理员' : '成员')}
                  </Tag>
                ),
              },
              {
                title: t('集群访问范围'),
                render: (_, a) =>
                  a.role === 'administrator'
                    ? t('全部集群')
                    : Object.keys(a.grants).length
                      ? clusters
                          .filter((c) => Object.hasOwn(a.grants, c.id))
                          .map((c) => <Tag key={c.id}>{c.name}</Tag>)
                      : t('尚未分配集群'),
              },
              {
                title: t('状态'),
                render: (_, a) => (
                  <Tag color={a.enabled ? 'green' : 'default'}>
                    {t(a.enabled ? '已启用' : '已停用')}
                  </Tag>
                ),
              },
              {
                title: t('创建时间'),
                dataIndex: 'created_at',
                render: (v) => displayTime(v, locale),
              },
              {
                title: t('操作'),
                render: (_, a) =>
                  a.bootstrap || a.username === username ? (
                    <span className="form-hint">{t('受保护')}</span>
                  ) : (
                    <Space>
                      <Button type="link" onClick={() => open(a)}>
                        {t('管理权限')}
                      </Button>
                      <Button danger type="text" onClick={() => remove(a)}>
                        {t('删除账号')}
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
        )}
      </Panel>
      <Drawer
        forceRender
        title={t(editing ? '管理权限' : '添加账号')}
        open={editing !== undefined}
        onClose={close}
        size="large"
        extra={<LanguageSwitch />}
        footer={
          <Space>
            <Button onClick={close}>{t('取消')}</Button>
            <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
              {t('保存权限')}
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            setError('');
            save.mutate(v);
          }}
          initialValues={{ role: 'member', enabled: true }}
        >
          <Form.Item
            name="username"
            label={t('用户名')}
            rules={[
              {
                required: true,
                pattern: /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/,
                message: t('使用 1–64 位字母、数字或 . _ @ -，以字母或数字开头'),
              },
            ]}
          >
            <Input autoComplete="off" disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="password"
            label={t(editing ? '重置密码' : '登录密码')}
            extra={t(editing ? '留空保留现有密码。' : '密码长度必须为 12–72 字节')}
            rules={[
              {
                validator: async (_, v) => {
                  const n = new TextEncoder().encode(v || '').length;
                  if ((!editing || n > 0) && (n < 12 || n > 72))
                    throw new Error(t('密码长度必须为 12–72 字节'));
                },
              },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <div className="access-form-row">
            <Form.Item name="role" label={t('角色')}>
              <Select
                options={[
                  { value: 'member', label: t('成员') },
                  { value: 'administrator', label: t('管理员') },
                ]}
              />
            </Form.Item>
            <Form.Item name="enabled" label={t('允许登录')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
          {role === 'administrator' ? (
            <Alert type="warning" showIcon title={t('管理员可以管理所有集群、账号和审计记录。')} />
          ) : (
            <>
              <h3>{t('集群授权')}</h3>
              <p className="form-hint">
                {t('勾选集群即允许查看配置。其他操作独立授权；只读接入始终禁止写入。')}
              </p>
              <div className="grant-list">
                {clusters.map((c) => {
                  const granted = Object.hasOwn(grants, c.id);
                  return (
                    <div className="grant-row" key={c.id}>
                      <Checkbox
                        checked={granted}
                        onChange={(e) => {
                          const next = { ...grants };
                          if (e.target.checked) next[c.id] = [];
                          else delete next[c.id];
                          setGrants(next);
                        }}
                      >
                        <strong>{c.name}</strong>{' '}
                        <small>{t(environmentNames[c.environment])}</small>
                      </Checkbox>
                      <div className="grant-options">
                        {keys.map((k) => (
                          <Checkbox
                            key={k}
                            aria-label={c.name + ' · ' + t(capabilities[k])}
                            disabled={!granted}
                            checked={grants[c.id]?.includes(k) ?? false}
                            onChange={(e) =>
                              setGrants({
                                ...grants,
                                [c.id]: e.target.checked
                                  ? [...grants[c.id], k]
                                  : grants[c.id].filter((x) => x !== k),
                              })
                            }
                          >
                            {t(capabilities[k])}
                          </Checkbox>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {editing && (
            <p className="form-hint">{t('保存后，该账号的现有会话将失效，需要重新登录。')}</p>
          )}
          {error && <Alert showIcon type="error" title={feedback(error)} />}
        </Form>
      </Drawer>
    </>
  );
}
type AuditRecord = {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
  cluster_id: string;
  outcome: string;
  http_status: number;
  created_at: string;
};
const outcomes: Record<string, [string, string]> = {
  success: ['成功', 'green'],
  denied: ['拒绝', 'red'],
  failed: ['失败', 'orange'],
  started: ['已开始', 'blue'],
  legacy: ['历史记录', 'default'],
};
const auditActions = [
  'login',
  'logout',
  'account.create',
  'account.update',
  'account.delete',
  'cluster.save',
  'cluster.probe',
  'draft.save',
  'draft.discard',
  'change.create',
  'change.publish',
  'change.succeeded',
  'change.rollback-preview',
  'change.cancel',
  'change.reconcile',
  'change.failed',
  'change.conflict',
  'change.unknown',
  'account.list',
  'cluster.list',
  'workspace.read',
  'resource.list',
  'resource.read',
  'resource.validate',
  'plugin.list',
  'plugin.catalog',
  'plugin.schema',
  'plugin.validate',
  'draft.list',
  'draft.read',
  'draft.validate',
  'change.list',
  'change.read',
  'change.validate',
  'audit.list',
];
export function Audit() {
  const t = useTranslate(),
    locale = useLocale();
  const { clusters, isAdmin, can, go } = useConsole();
  const [filters, setFilters] = useState({ cluster_id: '', outcome: '', actor: '', action: '' });
  const [actor, setActor] = useState('');
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters({ ...filters, [key]: value || '' });
    setCursors([]);
  };
  const allowed = clusters.filter((c) => can('audit', c.id));
  const params = new URLSearchParams({
    ...filters,
    limit: '31',
    ...(before ? { before_id: String(before) } : {}),
  });
  const query = useQuery({
    queryKey: ['audit', filters, before],
    queryFn: () => api<AuditRecord[]>('/audit?' + params),
    enabled: isAdmin || !!allowed.length,
  });
  const rows = query.data || [];
  return (
    <>
      <PageTitle
        eyebrow={t('审计记录')}
        title={t('操作审计')}
        description={t('按集群、操作人和结果追溯配置变更与访问决定。')}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => query.refetch()}>
            {t('刷新')}
          </Button>
        }
      />
      <Panel>
        <div className="audit-filters">
          <Select
            aria-label={t('审计范围')}
            value={filters.cluster_id}
            onChange={(v) => setFilter('cluster_id', v)}
            options={[
              { value: '', label: t(isAdmin ? '所有集群及系统事件' : '已授权审计的集群') },
              ...allowed.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <Input.Search
            aria-label={t('筛选操作人')}
            placeholder={t('筛选操作人')}
            allowClear
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              if (!e.target.value) setFilter('actor', '');
            }}
            onSearch={(v) => setFilter('actor', v.trim())}
          />
          <Select
            aria-label={t('审计操作')}
            allowClear
            showSearch
            placeholder={t('全部操作')}
            value={filters.action || undefined}
            options={auditActions.map((v) => ({ value: v, label: v }))}
            onChange={(v) => setFilter('action', v)}
          />
          <Select
            aria-label={t('操作结果')}
            allowClear
            placeholder={t('全部结果')}
            value={filters.outcome || undefined}
            options={Object.entries(outcomes).map(([value, [k]]) => ({ value, label: t(k) }))}
            onChange={(v) => setFilter('outcome', v)}
          />
        </div>
        {query.error ? (
          <RequestError error={query.error} />
        ) : (
          <Table<AuditRecord>
            rowKey="id"
            loading={query.isLoading}
            dataSource={rows.slice(0, 30)}
            pagination={false}
            scroll={{ x: 840 }}
            expandable={{
              rowExpandable: (r) => !!r.detail,
              expandedRowRender: (r) => <AuditDetail row={r} />,
            }}
            columns={[
              { title: t('时间'), dataIndex: 'created_at', render: (v) => displayTime(v, locale) },
              { title: t('操作人'), dataIndex: 'actor' },
              { title: t('操作'), dataIndex: 'action', render: (v) => <code>{v}</code> },
              {
                title: t('集群'),
                render: (_, r) =>
                  clusters.find((c) => c.id === r.cluster_id)?.name || r.cluster_id || t('系统'),
              },
              {
                title: t('对象'),
                dataIndex: 'target',
                render: (v, r) =>
                  /^[a-f0-9]{32}$/.test(v) &&
                  v !== r.cluster_id &&
                  r.cluster_id &&
                  (r.action.startsWith('draft.') || r.action.startsWith('change.')) ? (
                    <Button
                      type="link"
                      className="audit-target"
                      onClick={() =>
                        go(
                          r.action.startsWith('draft.') ? '/drafts?preview=' + v : '/changes/' + v,
                          r.cluster_id,
                        )
                      }
                    >
                      {v}
                    </Button>
                  ) : (
                    <code className="audit-target">{v || '—'}</code>
                  ),
              },
              {
                title: t('操作结果'),
                render: (_, r) => {
                  const [label, color] = outcomes[r.outcome] || outcomes.legacy;
                  return (
                    <Tag color={color}>
                      {t(label)}
                      {r.http_status ? ' · ' + r.http_status : ''}
                    </Tag>
                  );
                },
              },
            ]}
          />
        )}
        <div className="audit-pager">
          <Button
            disabled={!cursors.length || query.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            {t('上一页')}
          </Button>
          <span>{t('第 {0} 页', cursors.length + 1)}</span>
          <Button
            disabled={rows.length <= 30 || query.isFetching}
            onClick={() => setCursors([...cursors, rows[29].id])}
          >
            {t('下一页')}
          </Button>
        </div>
      </Panel>
    </>
  );
}

function AuditDetail({ row }: { row: AuditRecord }) {
  const t = useTranslate(),
    feedback = useFeedback();
  const { clusters } = useConsole();
  if (row.action !== 'account.update' && row.action !== 'account.create')
    return <div className="audit-detail">{feedback(row.detail)}</div>;
  let d: {
    role: string;
    before_role?: string;
    enabled: boolean;
    password_changed: boolean;
    grants: Grants;
    prior_grants: Grants | null;
  };
  try {
    d = JSON.parse(row.detail);
  } catch {
    return <span>—</span>;
  }
  const scope = (g: Grants | null, role?: string) =>
    role === 'administrator'
      ? t('全部集群')
      : Object.entries(g || {})
          .map(([id, caps]) => {
            const c = clusters.find((v) => v.id === id);
            return (
              (c?.name || id) +
              ' · ' +
              [t('查看'), ...caps.map((cap) => t(capabilities[cap]))].join(' / ')
            );
          })
          .join('；') || t('尚未分配集群');
  return (
    <div className="audit-grant-detail">
      <div>
        <strong>{t('角色')}</strong> {t(d.role === 'administrator' ? '管理员' : '成员')} ·{' '}
        {t(d.enabled ? '已启用' : '已停用')}
        {d.password_changed ? ' · ' + t('已设置新密码') : ''}
      </div>
      {d.before_role && (
        <div>
          <strong>{t('原授权')}</strong> {scope(d.prior_grants, d.before_role)}
        </div>
      )}
      <div>
        <strong>{t('新授权')}</strong> {scope(d.grants, d.role)}
      </div>
    </div>
  );
}

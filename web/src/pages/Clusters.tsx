import { languageFooter } from '../components/LanguageSwitch';
import { useFeedback } from '../i18n/feedback';
import { useLocaleForm } from '../i18n/useLocaleForm';
import { useLocale, useTranslate } from '../i18n';
import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import {
  CloudServerOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  DeleteOutlined,
  ArrowRightOutlined,
  SearchOutlined,
  ApiOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../api';
import { useConsole } from '../context';
import { PageTitle, Panel, Checks, Blank, RequestError } from '../components/Common';
import { displayTime, environmentNames, type Cluster, type Validation } from '../types';

const filters = { all: '全部连接', connected: '健康', error: '异常', pending: '待确认' } as const;
type Filter = keyof typeof filters;
function health(c: Cluster, now: number) {
  if (!c.last_checked) return 'unchecked';
  if (now - Date.parse(c.last_checked) > 120000) return 'stale';
  return c.status === 'connected' ? 'connected' : c.status === 'error' ? 'error' : 'unchecked';
}

function validAdminAddress(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      /^https?:\/\//i.test(value.trim()) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['', '/apisix/admin'].includes(url.pathname.replace(/\/+$/, ''))
    );
  } catch {
    return false;
  }
}
export function Clusters() {
  const feedback = useFeedback();
  const t = useTranslate();
  const locale = useLocale();
  const { clusterId, go } = useConsole();
  const listed = useQuery({
    queryKey: ['clusters'],
    queryFn: ({ signal }) => api<Cluster[]>('/clusters', { signal }),
    refetchInterval: 5000,
  });
  const clusters = listed.data || [];
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<Cluster | null>(null);
  const [expanded, setExpanded] = useState('');
  // Re-evaluate freshness even when polling returns identical cluster rows.
  const now = Math.max(listed.dataUpdatedAt, listed.errorUpdatedAt);
  const query = search.trim().toLowerCase();
  const counts = { all: clusters.length, connected: 0, error: 0, pending: 0 };
  const visible = clusters.filter((c) => {
    const state = health(c, now);
    const key = state === 'stale' || state === 'unchecked' ? 'pending' : state;
    counts[key]++;
    return (
      (filter === 'all' || filter === key) &&
      [c.name, c.url, c.description, t(environmentNames[c.environment])].some((v) =>
        v?.toLowerCase().includes(query),
      )
    );
  });
  const client = useQueryClient();
  const { message } = App.useApp();
  const [editing, setEditing] = useState<Cluster | null | undefined>(undefined);
  const form = useLocaleForm(editing !== undefined);
  const [results, setResults] = useState<Record<string, Validation>>({});
  const probe = useMutation({
    mutationFn: (id: string) => post<Validation>(`/clusters/${id}/probe`),
    onSuccess: (result, id) => {
      setResults((previous) => ({ ...previous, [id]: result }));
      setExpanded(id);
      client.invalidateQueries({ queryKey: ['clusters'] });
      message.open({
        key: 'cluster-probe-' + id,
        type: result.ok ? 'success' : 'warning',
        duration: 3,
        content: result.ok ? t('集群连接正常') : t('部分能力检测失败，请查看检测结果'),
      });
    },
    onError: (error, id) =>
      message.error({ key: 'cluster-probe-' + id, content: feedback(error.message) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('/clusters/' + id, { method: 'DELETE' }),
    onSuccess: async (_, id) => {
      setDeleting(null);
      const remaining = clusters.filter((c) => c.id !== id);
      if (visible.length === 1 && visible[0].id === id) {
        setSearch('');
        setFilter('all');
      }
      if (clusterId === id) go('/clusters', remaining[0]?.id || '');
      await client.invalidateQueries({ queryKey: ['clusters'] });
      await client.invalidateQueries({ queryKey: ['accounts'] });
      void client.invalidateQueries({ queryKey: ['audit'] });
      message.success(t('集群连接已删除'));
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api<Cluster>(editing ? `/clusters/${editing.id}` : '/clusters', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: async (c) => {
      setEditing(undefined);
      await client.invalidateQueries({ queryKey: ['clusters'] });
      go('/clusters', c.id);
      message.loading({
        key: 'cluster-probe-' + c.id,
        content: t('集群已保存，正在检测连接'),
        duration: 0,
      });
      probe.mutate(c.id);
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const open = (cluster: Cluster | null) => {
    form.resetFields();
    form.setFieldsValue(
      cluster ? { ...cluster, api_key: '' } : { environment: 'staging', read_only: false },
    );
    setEditing(cluster);
  };
  return (
    <>
      <PageTitle
        title={t('集群连接')}
        description={t('管理各环境的 Admin API 接入，查看最近一次连通性检测结果。')}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined aria-hidden="true" />}
            onClick={() => open(null)}
          >
            {t('接入集群')}
          </Button>
        }
      />
      {listed.isError && <RequestError error={listed.error} retry={() => listed.refetch()} />}
      {listed.isLoading ? (
        <Spin />
      ) : !clusters.length && !listed.isError ? (
        <Panel>
          <Blank
            text={t('还没有接入任何集群')}
            action={
              <Button type="primary" onClick={() => open(null)}>
                {t('接入第一个集群')}
              </Button>
            }
          />
        </Panel>
      ) : (
        clusters.length > 0 && (
          <>
            <div className="connection-toolbar">
              <div role="group" aria-label={t('按连接状态筛选')} className="connection-filters">
                {(Object.keys(filters) as Filter[]).map((f) => (
                  <button
                    type="button"
                    key={f}
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {t(filters[f])}
                    <span>{counts[f]}</span>
                  </button>
                ))}
              </div>
              <Input
                allowClear
                className="connection-search"
                prefix={<SearchOutlined />}
                aria-label={t('搜索集群')}
                placeholder={t('搜索名称或地址')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="connection-cadence">
              <SyncOutlined /> {t('后台每分钟探测 Admin API，页面每 5 秒更新。')}
            </div>
            <div className="cluster-grid">
              {visible.map((c) => {
                const state = health(c, now);
                const label = {
                  connected: '健康',
                  error: '异常',
                  unchecked: '尚未检测',
                  stale: '检测已过期',
                }[state];
                return (
                  <Panel
                    key={c.id}
                    className={`cluster-card ${clusterId === c.id ? 'selected-cluster' : ''}`}
                  >
                    <div className="cluster-card-top">
                      <div className="cluster-icon">
                        <CloudServerOutlined aria-hidden="true" />
                      </div>
                      <div className="connection-identity">
                        <div className="cluster-card-title">
                          <h2>{c.name}</h2>
                        </div>
                        <Space size={[4, 4]} wrap>
                          <Tag color={c.environment === 'production' ? 'orange' : 'blue'}>
                            {t(environmentNames[c.environment])}
                          </Tag>
                          {c.read_only && <Tag>{t('只读')}</Tag>}
                          {clusterId === c.id && (
                            <span className="selected-label">{t('当前集群')}</span>
                          )}
                        </Space>
                      </div>
                      <span className={'connection-health ' + state}>
                        <i />
                        {t(label)}
                      </span>
                    </div>
                    {c.description && <p className="cluster-description">{c.description}</p>}
                    <div className="cluster-address">
                      <ApiOutlined />
                      <div>
                        <small>{t('Admin API 地址')}</small>
                        <code>{c.url}</code>
                      </div>
                    </div>
                    <dl className="cluster-meta">
                      <div>
                        <dt>{t('探测耗时')}</dt>
                        <dd>
                          {c.probe_latency_ms == null ? '—' : (c.probe_latency_ms || '<1') + ' ms'}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('APISIX 版本')}</dt>
                        <dd>{c.version || t('未探测')}</dd>
                      </div>
                      <div>
                        <dt>{t('最近检测')}</dt>
                        <dd>{displayTime(c.last_checked, locale)}</dd>
                      </div>
                    </dl>
                    {c.status === 'error' && c.probe_error && (
                      <div className="connection-fault">{feedback(c.probe_error)}</div>
                    )}
                    {results[c.id] && (
                      <details
                        open={expanded === c.id}
                        className="connection-diagnostics"
                        onToggle={(e) => {
                          if (e.currentTarget.open) setExpanded(c.id);
                          else setExpanded((prev) => (prev === c.id ? '' : prev));
                        }}
                      >
                        <summary>{t('手动检测结果')}</summary>
                        <Checks checks={results[c.id].checks} />
                      </details>
                    )}
                    <div className="cluster-actions">
                      <Button type="primary" ghost onClick={() => go('/routes', c.id)}>
                        {t('进入集群')}
                        <ArrowRightOutlined />
                      </Button>
                      <Button
                        icon={<LinkOutlined aria-hidden="true" />}
                        loading={probe.isPending && probe.variables === c.id}
                        onClick={() => probe.mutate(c.id)}
                      >
                        {t('检测连接')}
                      </Button>
                      <Button icon={<EditOutlined aria-hidden="true" />} onClick={() => open(c)}>
                        {t('编辑')}
                      </Button>
                      <Tooltip title={t('删除连接')}>
                        <Button
                          danger
                          type="text"
                          className="connection-delete"
                          icon={<DeleteOutlined />}
                          aria-label={t('删除连接')}
                          onClick={() => setDeleting(c)}
                        />
                      </Tooltip>
                    </div>
                  </Panel>
                );
              })}
            </div>
            {!visible.length && (
              <Panel>
                <Blank
                  text={t('没有匹配的集群连接')}
                  action={
                    <Button
                      onClick={() => {
                        setSearch('');
                        setFilter('all');
                      }}
                    >
                      {t('清除筛选')}
                    </Button>
                  }
                />
              </Panel>
            )}
          </>
        )
      )}
      <Modal
        title={t('删除集群连接')}
        open={!!deleting}
        footer={languageFooter}
        onCancel={() => {
          if (!remove.isPending) setDeleting(null);
        }}
        onOk={() => deleting && remove.mutate(deleting.id)}
        okText={t('删除连接')}
        okButtonProps={{ danger: true }}
        confirmLoading={remove.isPending}
        cancelText={t('取消')}
      >
        <p>{t('确认从 Dashboard 移除「{0}」？', deleting?.name || '')}</p>
        <p>
          {t(
            '将清除保存的管理密钥和集群授权，并停止探测。网关上的路由和上游继续运行，历史发布与审计记录保留。',
          )}
        </p>
      </Modal>
      <Modal
        footer={languageFooter}
        title={editing ? t('编辑集群连接') : t('接入 APISIX 集群')}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText={t('保存并检测')}
        cancelText={t('取消')}
        width={580}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save.mutate}>
          <div className="form-two">
            <Form.Item
              name="name"
              label={t('集群名称')}
              rules={[{ required: true, message: t('请输入集群名称') }]}
            >
              <Input placeholder={t('例如：测试网关')} maxLength={100} />
            </Form.Item>
            <Form.Item name="environment" label={t('所属环境')} rules={[{ required: true }]}>
              <Select
                disabled={!!editing}
                options={Object.entries(environmentNames).map(([value, label]) => ({
                  value,
                  label: t(label),
                }))}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="url"
            label={t('Admin API 地址')}
            extra={t('填写管理后端可访问的地址。地址与环境保存后固定，更换目标请新建连接。')}
            rules={[
              { required: true, message: t('请输入 Admin API 地址') },
              {
                validator: (_, value) =>
                  !value || validAdminAddress(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('请输入完整的 HTTP 或 HTTPS 地址'))),
              },
            ]}
          >
            <Input disabled={!!editing} placeholder="http://apisix:9180" />
          </Form.Item>
          <Form.Item
            name="api_key"
            label="Admin API Key"
            rules={[{ required: !editing, message: t('请输入管理密钥') }]}
            extra={
              editing
                ? t('留空保留原有密钥；原值不会回显。')
                : t('密钥仅保存在服务端，用于管理网关。')
            }
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={editing ? t('留空保留现有密钥') : t('请输入专用管理密钥')}
            />
          </Form.Item>
          <Form.Item name="description" label={t('说明')}>
            <Input.TextArea
              rows={2}
              maxLength={300}
              placeholder={t('集群用途、负责人或网络说明')}
            />
          </Form.Item>
          <Form.Item name="read_only" label={t('只读接入')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Alert type="info" showIcon title={t('连接检测只读取资源和插件信息，不修改网关配置。')} />
        </Form>
      </Modal>
    </>
  );
}

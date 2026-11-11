import { messageText } from '../i18n/Message';
import { languageFooter } from '../components/LanguageSwitch';
import { useFeedback } from '../i18n/feedback';
import { useTranslate, type Translate } from '../i18n';
import { useMemo, useState } from 'react';
import { Alert, App, Button, Dropdown, Input, Select, Space, Table, Tag, Tooltip } from 'antd';
import {
  ApartmentOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
  ApiOutlined,
  UserOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { type PluginDefinition } from '../plugins';
import { api, post } from '../api';
import { useConsole } from '../context';
import { Blank, NoCluster, PageTitle, Panel, RequestError } from '../components/Common';
import { kindNames, type Draft, type Resource, type ResourceKind } from '../types';

function nodesLabel(value: Resource['value'], t: Translate) {
  if (Array.isArray(value.nodes)) return t('{0} 个节点', value.nodes.length);
  if (value.nodes && typeof value.nodes === 'object')
    return t('{0} 个节点', Object.keys(value.nodes).length);
  if (value.discovery_type) return t('服务发现 · {0}', value.discovery_type);
  return t('未配置节点');
}
export function Resources({ kind }: { kind: ResourceKind }) {
  const feedback = useFeedback();
  const t = useTranslate();
  const [params, setParams] = useSearchParams();
  const pluginFilter = kind === 'consumers' ? params.get('plugin') || '' : '';
  const { cluster, clusterId, go, can } = useConsole();
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [compact, setCompact] = useState(localStorage.getItem('console.density') === 'compact');
  const resources = useQuery({
    queryKey: ['resources', clusterId, kind],
    queryFn: () =>
      api<{ items: Resource[]; total: number }>(`/clusters/${clusterId}/resources/${kind}`),
    enabled: !!clusterId,
  });
  const upstreams = useQuery({
    queryKey: ['resources', clusterId, 'upstreams'],
    queryFn: () =>
      api<{ items: Resource[]; total: number }>(`/clusters/${clusterId}/resources/upstreams`),
    enabled: !!clusterId && kind === 'routes',
  });
  const drafts = useQuery({
    queryKey: ['drafts', clusterId],
    queryFn: () => api<Draft[]>(`/drafts?cluster_id=${clusterId}`),
    enabled: !!clusterId,
  });
  const activeDrafts =
    drafts.data?.filter((d) => d.status === 'draft' && d.resource_type === kind) || [];
  const catalog = useQuery({
    queryKey: ['plugin-catalog', clusterId],
    queryFn: () => api<PluginDefinition[]>(`/clusters/${clusterId}/plugins/catalog`),
    enabled: !!clusterId && kind === 'consumers',
  });
  const visible = useMemo(
    () =>
      (resources.data?.items || []).filter((resource) => {
        const v = resource.value;
        const haystack = [
          resource.id,
          v.name,
          v.username,
          v.uri,
          ...(v.uris || []),
          v.host,
          ...(v.hosts || []),
          JSON.stringify(v.labels || {}),
          v.desc,
        ]
          .join(' ')
          .toLowerCase();
        return (
          haystack.includes(query.toLowerCase()) &&
          (!pluginFilter || !!v.plugins?.[pluginFilter]) &&
          (status === 'all' || (status === 'active' ? v.status !== 0 : v.status === 0))
        );
      }),
    [resources.data, query, status, pluginFilter],
  );
  if (!cluster) return <NoCluster />;
  const edit = (resource: Resource) => {
    const existing = activeDrafts.find((d) => d.resource_id === resource.id);
    go(existing ? `/drafts/${existing.id}/edit` : `/${kind}/${resource.id}/edit`);
  };
  const remove = (resource: Resource) =>
    modal.confirm({
      footer: languageFooter,
      title: messageText('将“{0}”加入删除草稿？', resource.value.name || resource.id),
      content: messageText('此操作先保存草稿。提交发布前，会检查资源引用关系与最新配置。'),
      okText: messageText('创建删除草稿'),
      cancelText: messageText('取消'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await post('/drafts', {
            cluster_id: clusterId,
            resource_type: kind,
            resource_id: resource.id,
            action: 'delete',
            title: t('删除 {0}', resource.value.name || resource.id).slice(0, 60),
            base_hash: resource.hash,
            value: null,
          });
          await client.invalidateQueries({ queryKey: ['drafts'] });
          message.success(t('删除草稿已保存'));
          go('/drafts');
        } catch (err) {
          message.error(feedback((err as Error).message));
          throw err;
        }
      },
    });
  const columns = [
    {
      title: t('{0}名称', t(kindNames[kind])),
      key: 'name',
      width: kind === 'routes' ? 245 : 280,
      sorter: (a: Resource, b: Resource) =>
        String(a.value.name || a.id).localeCompare(String(b.value.name || b.id)),
      render: (_: unknown, r: Resource) => (
        <div className="resource-identity">
          <span className={`resource-symbol ${kind}`}>
            {kind === 'routes' ? (
              <ApiOutlined aria-hidden="true" />
            ) : kind === 'consumers' ? (
              <UserOutlined aria-hidden="true" />
            ) : (
              <ApartmentOutlined aria-hidden="true" />
            )}
          </span>
          <div className="resource-name">
            <button className="text-link" onClick={() => edit(r)}>
              {r.value.name || r.id}
            </button>
            <div className="resource-subtitle">{r.value.desc || r.id}</div>
            {activeDrafts.some((d) => d.resource_id === r.id) && (
              <Tag className="inline-draft" color="gold">
                {t('有草稿')}
              </Tag>
            )}
          </div>
        </div>
      ),
    },
    ...(kind === 'routes'
      ? [
          {
            title: t('请求匹配'),
            key: 'match',
            width: 245,
            render: (_: unknown, r: Resource) => (
              <div>
                <div className="mono resource-uri">
                  {r.value.uri || r.value.uris?.join(', ') || '—'}
                </div>
                <div className="method-tags">
                  {r.value.methods?.length ? (
                    r.value.methods.slice(0, 4).map((method: string) => (
                      <span className={`method method-${method.toLowerCase()}`} key={method}>
                        {method}
                      </span>
                    ))
                  ) : (
                    <span className="muted">{t('所有方法')}</span>
                  )}
                  {(r.value.host || r.value.hosts?.length) && (
                    <Tooltip title={r.value.host || r.value.hosts.join(', ')}>
                      <span className="host-label">{r.value.host || r.value.hosts[0]}</span>
                    </Tooltip>
                  )}
                </div>
              </div>
            ),
          },
          {
            title: t('转发目标'),
            key: 'upstream',
            width: 180,
            render: (_: unknown, r: Resource) => (
              <div className="upstream-cell">
                <ApartmentOutlined aria-hidden="true" />
                <div>
                  {r.value.upstream_id ? (
                    <button
                      className="text-link"
                      onClick={() => go(`/upstreams/${r.value.upstream_id}/edit`)}
                    >
                      {upstreams.data?.items.find((u) => u.id === String(r.value.upstream_id))
                        ?.value.name || r.value.upstream_id}
                    </button>
                  ) : (
                    <span>
                      {r.value.upstream
                        ? t('内联上游')
                        : r.value.service_id
                          ? t('服务 {0}', r.value.service_id)
                          : t('插件处理')}
                    </span>
                  )}
                  <small>
                    {r.value.upstream_id
                      ? t('独立上游')
                      : r.value.upstream
                        ? nodesLabel(r.value.upstream, t)
                        : t('保留原始配置')}
                  </small>
                </div>
              </div>
            ),
          },
          {
            title: t('插件'),
            key: 'plugins',
            width: 190,
            render: (_: unknown, r: Resource) => {
              const names = Object.keys(r.value.plugins || {});
              return (
                <div className="plugin-tags">
                  {names.slice(0, 2).map((name) => (
                    <Tag key={name}>{name}</Tag>
                  ))}
                  {names.length > 2 && (
                    <Tooltip title={names.slice(2).join('、')}>
                      <Tag>+{names.length - 2}</Tag>
                    </Tooltip>
                  )}
                  {!names.length && <span className="muted">{t('未配置')}</span>}
                </div>
              );
            },
          },
          {
            title: t('状态'),
            key: 'status',
            width: 100,
            render: (_: unknown, r: Resource) => (
              <span className={`resource-state ${r.value.status === 0 ? 'disabled' : 'enabled'}`}>
                <i aria-hidden="true" />
                {r.value.status === 0 ? t('已停用') : t('已启用')}
              </span>
            ),
          },
        ]
      : kind === 'consumers'
        ? [
            {
              title: t('认证凭据'),
              key: 'credential',
              width: 180,
              render: (_: unknown, r: Resource) => (
                <Tag
                  icon={<KeyOutlined aria-hidden="true" />}
                  color={
                    catalog.data?.some(
                      (item) => item.consumer_source !== 'none' && r.value.plugins?.[item.name],
                    )
                      ? 'green'
                      : 'default'
                  }
                >
                  {catalog.isLoading
                    ? t('加载中')
                    : t(
                        '{0} 种认证 · 凭据已隐藏',
                        catalog.data?.filter(
                          (item) => item.consumer_source !== 'none' && r.value.plugins?.[item.name],
                        ).length ?? 0,
                      )}
                </Tag>
              ),
            },
            {
              title: t('消费者插件'),
              key: 'plugins',
              render: (_: unknown, r: Resource) => (
                <div className="plugin-tags">
                  {Object.keys(r.value.plugins || {}).map((name) => (
                    <Tag key={name}>{name}</Tag>
                  ))}
                </div>
              ),
            },
            {
              title: t('标签'),
              key: 'labels',
              render: (_: unknown, r: Resource) => (
                <div className="plugin-tags">
                  {Object.entries(r.value.labels || {}).map(([name, value]) => (
                    <Tag key={name}>
                      {name}={String(value)}
                    </Tag>
                  ))}
                </div>
              ),
            },
          ]
        : [
            {
              title: t('节点'),
              key: 'nodes',
              render: (_: unknown, r: Resource) => (
                <div>
                  <strong className="normal-weight">{nodesLabel(r.value, t)}</strong>
                  <div className="resource-subtitle mono">
                    {Array.isArray(r.value.nodes)
                      ? r.value.nodes
                          .slice(0, 2)
                          .map((n: { host: string; port: number }) => `${n.host}:${n.port}`)
                          .join(' / ')
                      : Object.keys(r.value.nodes || {})
                          .slice(0, 2)
                          .join(' / ')}
                  </div>
                </div>
              ),
            },
            {
              title: t('负载均衡'),
              key: 'type',
              width: 150,
              render: (_: unknown, r: Resource) => <Tag>{r.value.type || 'roundrobin'}</Tag>,
            },
            {
              title: t('协议'),
              key: 'scheme',
              width: 90,
              render: (_: unknown, r: Resource) => (
                <span className="mono">{(r.value.scheme || 'http').toUpperCase()}</span>
              ),
            },
            {
              title: t('连接超时'),
              key: 'timeout',
              width: 110,
              render: (_: unknown, r: Resource) =>
                r.value.timeout?.connect !== undefined ? (
                  t('{0} 秒', r.value.timeout.connect)
                ) : (
                  <span className="muted">{t('网关默认')}</span>
                ),
            },
          ]),
    {
      title: t('操作'),
      key: 'actions',
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, r: Resource) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => edit(r)}>
            {cluster.read_only || !can('edit') ? t('查看') : t('编辑')}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'copy',
                  label: t('复制为新配置'),
                  icon: <CopyOutlined aria-hidden="true" />,
                  disabled: cluster.read_only || !can('edit') || kind === 'consumers',
                  onClick: () => go(`/${kind}/new?copy=${r.id}`),
                },
                {
                  key: 'delete',
                  label: t('创建删除草稿'),
                  danger: true,
                  disabled: cluster.read_only || !can('edit'),
                  icon: <DeleteOutlined aria-hidden="true" />,
                  onClick: () => remove(r),
                },
              ],
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<MoreOutlined aria-hidden="true" />}
              aria-label={t('更多操作 {0}', r.value.name || r.id)}
            />
          </Dropdown>
        </Space>
      ),
    },
  ];
  return (
    <>
      <PageTitle
        eyebrow={
          kind === 'routes' ? t('流量路由') : kind === 'consumers' ? t('消费者身份') : t('上游服务')
        }
        title={t(kindNames[kind] + '管理')}
        description={
          kind === 'routes'
            ? t('定义请求如何匹配、经过哪些插件，以及最终流向哪里。')
            : kind === 'consumers'
              ? t('统一管理调用方身份、多种认证凭据与消费者策略。')
              : t('管理转发节点与负载均衡，清楚掌握服务之间的依赖。')
        }
        extra={
          <>
            <Button
              icon={<ReloadOutlined aria-hidden="true" />}
              loading={resources.isFetching}
              onClick={() => resources.refetch()}
            >
              {t('刷新')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined aria-hidden="true" />}
              disabled={cluster.read_only || !can('edit')}
              onClick={() =>
                go(
                  `/${kind}/new${pluginFilter ? `?plugin=${encodeURIComponent(pluginFilter)}` : ''}`,
                )
              }
            >
              {t('新建' + kindNames[kind])}
            </Button>
          </>
        }
      />
      {kind === 'consumers' && (
        <Alert
          className="consumer-guide"
          showIcon
          type="info"
          title={t('凭据配置在消费者，认证规则配置在路由')}
          description={t(
            '支持 API Key、Basic、JWT、HMAC、JWE、LDAP 等认证方式。选择目标网关支持的插件，配置凭据并发布，再在路由启用相应认证规则。',
          )}
        />
      )}
      {pluginFilter && (
        <Tag
          closable
          onClose={() =>
            setParams((previous) => {
              previous.delete('plugin');
              return previous;
            })
          }
        >
          {t('关联插件：{0}', pluginFilter)}
        </Tag>
      )}
      <div className="resource-summary">
        <span>
          <b>{resources.data?.total ?? '—'}</b> {t('个' + kindNames[kind])}
        </span>
        <span className="summary-divider" />
        {kind === 'routes' && (
          <>
            <span>
              <i className="tiny-dot" />
              {resources.data?.items.filter((r) => r.value.status !== 0).length ?? '—'}{' '}
              {t('已启用')}
            </span>
            <span className="summary-divider" />
          </>
        )}
        <button className="text-link" onClick={() => go('/drafts')}>
          {drafts.data ? activeDrafts.length : '—'} {t('份未提交草稿')}
        </button>
        <span className="summary-right">{cluster.name}</span>
      </div>
      {resources.isError ? (
        <RequestError error={resources.error} retry={() => resources.refetch()} />
      ) : (
        <Panel className="resource-panel">
          <div className="table-toolbar">
            <Input
              aria-label={t('搜索资源')}
              prefix={<SearchOutlined aria-hidden="true" />}
              placeholder={
                kind === 'consumers'
                  ? t('搜索消费者用户名、说明或标签…')
                  : t('搜索名称、ID、路径或标签…')
              }
              allowClear
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="resource-search"
            />
            {kind === 'routes' && (
              <Select
                aria-label={t('筛选路由状态')}
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'all', label: t('全部状态') },
                  { value: 'active', label: t('已启用') },
                  { value: 'disabled', label: t('已停用') },
                ]}
              />
            )}
            <div className="toolbar-spacer" />
            <Button
              type="text"
              icon={<SwapOutlined aria-hidden="true" rotate={90} />}
              onClick={() => {
                setCompact((v) => !v);
                localStorage.setItem('console.density', compact ? 'standard' : 'compact');
              }}
            >
              {compact ? t('标准密度') : t('紧凑密度')}
            </Button>
          </div>
          <Table<Resource>
            className="resource-table"
            rowClassName={(resource) => (resource.value.status === 0 ? 'resource-disabled' : '')}
            rowKey="id"
            columns={columns}
            dataSource={visible}
            loading={resources.isLoading}
            size={compact ? 'small' : 'middle'}
            scroll={{ x: kind === 'routes' ? 1100 : 800 }}
            pagination={{
              pageSize: 15,
              showSizeChanger: true,
              pageSizeOptions: [15, 30, 50],
              showTotal: (total) => t('共 {0} 条配置', total),
            }}
            locale={{
              emptyText: resources.isPending ? (
                <span role="status">{t('加载中')}</span>
              ) : (
                <Blank
                  text={
                    query || pluginFilter || status !== 'all'
                      ? t('没有匹配的配置')
                      : t('当前环境暂无{0}配置', t(kindNames[kind]))
                  }
                />
              ),
            }}
          />
        </Panel>
      )}
      <div className="page-footnote">
        <EditOutlined aria-hidden="true" />
        <span>{t('所有配置编辑先保存为草稿。发布前可以检查差异、引用关系与配置冲突。')}</span>
      </div>
    </>
  );
}

import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Radio, Select, Tabs, Tag } from 'antd';
import { ApartmentOutlined, BlockOutlined, CodeOutlined, ProfileOutlined } from '@ant-design/icons';
import { api } from '../api';
import { RequestError } from '../components/Common';
import { PluginManager } from '../components/PluginManager';
import { patchField } from '../config';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import { maskPluginSecrets, type PluginDefinition } from '../plugins';
import { pretty, type JsonObject, type Resource } from '../types';
import { KeyValueFields, StringListField, ToggleSetting } from './Fields';
import { UpstreamFields } from './UpstreamFields';

type Target = 'reference' | 'inline' | 'none';

function ServiceUpstream({
  value,
  onChange,
}: {
  value: JsonObject;
  onChange: (v: JsonObject) => void;
}) {
  const t = useTranslate();
  const { clusterId } = useConsole();
  const mode: Target =
    value.upstream !== undefined
      ? 'inline'
      : value.upstream_id !== undefined
        ? 'reference'
        : 'none';
  const previous = useRef<{ inline?: JsonObject; reference?: string | number }>({});
  const upstreams = useQuery({
    queryKey: ['resources', clusterId, 'upstreams'],
    queryFn: () => api<{ items: Resource[] }>(`/clusters/${clusterId}/resources/upstreams`),
    enabled: mode === 'reference',
  });
  const options = upstreams.data?.items.map(({ id, value }) => ({
    value: String(id),
    label: value.name ? `${value.name} · ${id}` : String(id),
  }));
  const selected =
    value.upstream_id === undefined || value.upstream_id === ''
      ? undefined
      : String(value.upstream_id);
  const target = upstreams.data?.items.find((item) => String(item.id) === selected);
  function selectMode(next: Target) {
    const { upstream, upstream_id, ...rest } = value;
    if (mode === 'inline') previous.current.inline = upstream;
    if (mode === 'reference') previous.current.reference = upstream_id;
    if (next === 'reference') rest.upstream_id = previous.current.reference ?? '';
    if (next === 'inline')
      rest.upstream = previous.current.inline ?? { type: 'roundrobin', nodes: {} };
    onChange(rest);
  }
  return (
    <>
      <Form.Item label={t('上游来源')}>
        <Radio.Group
          aria-label={t('上游来源')}
          value={mode}
          onChange={(e) => selectMode(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          options={[
            { value: 'reference', label: t('引用已有上游') },
            { value: 'inline', label: t('内联上游') },
            { value: 'none', label: t('由路由提供上游') },
          ]}
        />
      </Form.Item>
      {mode === 'reference' && (
        <>
          <Form.Item
            label={t('选择上游')}
            required
            extra={t('按名称或 ID 搜索当前集群的上游。服务保存所选上游的 ID。')}
          >
            <Select
              aria-label={t('选择上游')}
              showSearch={{ optionFilterProp: 'label' }}
              allowClear
              loading={upstreams.isFetching}
              placeholder={t('搜索上游名称或 ID')}
              value={selected}
              options={options}
              notFoundContent={upstreams.isFetching ? t('加载中') : t('未找到匹配的上游')}
              onChange={(id) => onChange({ ...value, upstream_id: id ?? '' })}
            />
          </Form.Item>
          {upstreams.error && (
            <RequestError error={upstreams.error} retry={() => upstreams.refetch()} />
          )}
          {target && (
            <div className="service-target-summary">
              <ApartmentOutlined aria-hidden="true" />
              <div>
                <strong>{target.value.name || target.id}</strong>
                <code>{target.id}</code>
              </div>
              <Tag>{String(target.value.scheme || 'http').toUpperCase()}</Tag>
              <Tag>{target.value.type || 'roundrobin'}</Tag>
              <Tag>
                {target.value.discovery_type
                  ? `${target.value.discovery_type} · ${target.value.service_name}`
                  : t('{0} 个节点', Object.keys(target.value.nodes || {}).length)}
              </Tag>
            </div>
          )}
          {selected && options && !target && (
            <Alert
              type="warning"
              showIcon
              title={t('当前集群中找不到上游 {0}，请重新选择。', selected)}
            />
          )}
        </>
      )}
      {mode === 'inline' && (
        <UpstreamFields
          value={value.upstream}
          onChange={(upstream) => onChange({ ...value, upstream })}
        />
      )}
      {mode === 'none' && (
        <Alert
          type="info"
          showIcon
          title={t('服务仅共享插件等设置，需要转发的路由可自行指定上游。')}
        />
      )}
    </>
  );
}

export function ServiceFields({
  value,
  onChange,
  identity,
  json,
  resourceId,
  draftId,
  pending,
  creating,
}: {
  value?: JsonObject;
  onChange: (next: JsonObject) => void;
  identity: ReactNode;
  json: ReactNode;
  resourceId?: string;
  draftId?: string;
  pending: boolean;
  creating: boolean;
}) {
  const t = useTranslate();
  const { clusterId } = useConsole();
  const [tab, setTab] = useState(value ? 'basic' : 'preview');
  const [editJSON, setEditJSON] = useState(!value);
  const catalog = useQuery({
    queryKey: ['plugin-catalog', clusterId],
    queryFn: () => api<PluginDefinition[]>(`/clusters/${clusterId}/plugins/catalog`),
    enabled: tab === 'preview' && !editJSON,
  });
  const field = (name: string, next: unknown) => value && onChange(patchField(value, name, next));
  return (
    <Tabs
      className="service-editor-tabs"
      activeKey={tab}
      onChange={setTab}
      items={[
        {
          key: 'basic',
          label: t('基本信息'),
          icon: <ProfileOutlined />,
          disabled: !value,
          children: value && (
            <>
              <div className="form-two">
                {identity}
                <Form.Item label={t('服务名称')} required={creating}>
                  <Input
                    aria-label={t('服务名称')}
                    value={value.name ?? ''}
                    onChange={(e) => field('name', e.target.value)}
                  />
                </Form.Item>
              </div>
              <Form.Item label={t('描述')}>
                <Input.TextArea
                  aria-label={t('服务描述')}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  value={value.desc ?? ''}
                  onChange={(e) => field('desc', e.target.value)}
                />
              </Form.Item>
              <Form.Item label={t('服务域名')}>
                <StringListField
                  label={t('域名')}
                  placeholder="api.example.com"
                  scope="service.hosts"
                  value={value.hosts ?? []}
                  onChange={(hosts) => field('hosts', hosts.length ? hosts : undefined)}
                />
              </Form.Item>
              <Form.Item label={t('标签')}>
                <KeyValueFields
                  label={t('标签')}
                  scope="service.labels"
                  value={value.labels}
                  onChange={(labels) =>
                    field('labels', Object.keys(labels).length ? labels : undefined)
                  }
                />
              </Form.Item>
              <ToggleSetting
                label="WebSocket"
                description={t('允许 HTTP / HTTPS 上游进行 WebSocket 协议升级。')}
                value={value.enable_websocket === true}
                onChange={(enabled) => field('enable_websocket', enabled)}
              />
            </>
          ),
        },
        {
          key: 'upstream',
          label: t('上游服务'),
          icon: <ApartmentOutlined />,
          disabled: !value,
          children: value && <ServiceUpstream value={value} onChange={onChange} />,
        },
        {
          key: 'plugins',
          label: t('插件配置'),
          icon: <BlockOutlined />,
          disabled: !value,
          children: value && (
            <PluginManager
              value={value.plugins ?? {}}
              resourceType="services"
              resourceId={resourceId}
              draftId={draftId}
              onChange={(plugins) => field('plugins', plugins)}
            />
          ),
        },
        {
          key: 'preview',
          label: t('配置预览'),
          icon: <CodeOutlined />,
          disabled: pending,
          children: (
            <>
              {editJSON || !value ? (
                json
              ) : catalog.error ? (
                <RequestError error={catalog.error} retry={() => catalog.refetch()} />
              ) : catalog.data ? (
                <pre className="ops-preview service-json">
                  {pretty(maskPluginSecrets(value, catalog.data, false, t('••••••（凭据已隐藏）')))}
                </pre>
              ) : (
                t('加载中')
              )}
              <Button disabled={editJSON && !value} onClick={() => setEditJSON(!editJSON)}>
                {editJSON ? t('返回预览') : t('JSON 编辑')}
              </Button>
            </>
          ),
        },
      ]}
    />
  );
}

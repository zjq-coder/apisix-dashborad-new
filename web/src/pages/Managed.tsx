import { DiffView } from '../components/DiffView';
import { useConfigWrite } from '../useConfigWrite';
import { RouteActionDialog } from './RouteActions';
import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
} from 'antd';
import { useSearchParams } from 'react-router-dom';
import { api, post } from '../api';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import { useFeedback } from '../i18n/feedback';
import { BufferContext } from '../editor/Fields';
import { formTypeErrors, validateConfig } from '../editor/config';
import { ServiceFields } from '../editor/ServiceFields';
import { PluginManager } from '../components/PluginManager';
import { Checks, NoCluster, PageTitle, Panel, RequestError } from '../components/Common';
import {
  kindNames,
  pretty,
  type Draft,
  type Resource,
  type JsonObject,
  type Validation,
} from '../types';

const templates: Record<string, JsonObject> = {
  plugin_configs: { desc: '', plugins: {} },
  global_rules: { plugins: {} },
  plugin_metadata: { log_format: { host: '$host' } },
  services: { upstream_id: '', plugins: {} },
  stream_routes: { server_port: 9100, upstream_id: '' },
  protos: { content: 'syntax = "proto3";\npackage example;\nmessage Ping { string text = 1; }' },
  secrets: { uri: 'https://vault.example.org', prefix: '/kv', token: '' },
  consumer_groups: { desc: '', plugins: {} },
  credentials: { plugins: { 'key-auth': { key: '' } } },
  ssls: { snis: [], cert: '', key: '' },
};
const policies = ['plugin_configs', 'global_rules', 'plugin_metadata'];
const extended = [
  'services',
  'stream_routes',
  'protos',
  'secrets',
  'consumer_groups',
  'credentials',
  'ssls',
];
const fields: Record<string, string[]> = {
  protos: ['content'],
  stream_routes: ['server_port', 'upstream_id'],
  secrets: ['uri', 'prefix', 'token'],
  ssls: ['cert', 'key'],
  plugin_configs: ['desc'],
  consumer_groups: ['desc'],
};
export const managedKind = (kind: string) => Object.hasOwn(templates, kind);
export interface Ref {
  kind: string;
  id: string;
}
export function RefList({ items }: { items: Ref[] }) {
  return (
    <Space wrap>
      {items.length
        ? items.map((v) => (
            <Tag key={v.kind + '/' + v.id}>
              {v.kind}/{v.id}
            </Tag>
          ))
        : '—'}
    </Space>
  );
}
export function ManagedEditor({
  kind,
  item,
  draft,
  owner,
  onDone,
}: {
  kind: string;
  item?: Resource;
  draft?: Draft;
  owner?: string;
  onDone: () => void;
}) {
  const t = useTranslate();
  const { clusterId } = useConsole();
  const direct = useConfigWrite();
  const [id, setId] = useState(
    draft?.resource_id ||
      item?.id ||
      (kind === 'credentials' && owner ? owner + ':' : kind === 'secrets' ? 'vault:' : ''),
  );
  const [raw, setRaw] = useState(() => {
    const v = { ...(draft?.after || item?.value || templates[kind]) };
    delete v.id;
    delete v.create_time;
    delete v.update_time;
    return pretty(v);
  });
  const [err, setErr] = useState<unknown>();
  const [pendingAction, setPendingAction] = useState<'validate' | 'write' | null>(null);
  const [validation, setValidation] = useState<Validation>();
  const editVersion = useRef(0);
  const [confirm, setConfirm] = useState(false);
  const feedback = useFeedback();
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const reportBuffer = useCallback((scope: string, issue: string) => {
    setBuffers((current) => {
      if ((current[scope] || '') === issue) return current;
      const next = { ...current };
      if (issue) next[scope] = issue;
      else delete next[scope];
      return next;
    });
  }, []);
  let obj: JsonObject | undefined;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v;
  } catch {
    /* Keep incomplete JSON editable. */
  }
  const update = (next: string) => {
    editVersion.current++;
    setRaw(next);
    setValidation(undefined);
    setErr(undefined);
    setConfirm(false);
  };
  const provider = id.split(':')[0];
  const providerTemplates: Record<string, JsonObject> = {
    vault: templates.secrets,
    aws: { access_key_id: '', secret_access_key: '', region: 'us-east-1' },
    gcp: { auth_file: '', ssl_verify: true },
  };
  const formFields =
    kind === 'secrets'
      ? provider === 'aws'
        ? ['access_key_id', 'secret_access_key', 'region']
        : provider === 'gcp'
          ? obj?.auth_file !== undefined
            ? ['auth_file']
            : []
          : fields.secrets
      : fields[kind];
  const global = kind === 'global_rules' || kind === 'plugin_metadata';
  const service = kind === 'services';
  const creating = !item && (!draft || draft.action === 'create');
  const shapeErrors = service && obj ? formTypeErrors('services', obj) : [];
  const issues =
    service && obj
      ? [
          ...Object.values(buffers),
          ...(creating && !obj.name ? ['请填写服务名称'] : []),
          ...validateConfig('services', obj).map((issue) => issue.message),
        ]
      : [];
  const ready = !!obj && !!id && !issues.length;
  async function submit(validate: boolean) {
    if (!ready || !obj || pendingAction) return;
    setPendingAction(validate ? 'validate' : 'write');
    setErr(undefined);
    try {
      const body = { resource_id: id, resource_type: kind, value: obj };
      if (validate) {
        const version = editVersion.current;
        const result = await post<Validation>('/clusters/' + clusterId + '/validate', {
          ...body,
          draft_id: draft?.id,
          include_diff: true,
        });
        if (editVersion.current === version) setValidation(result);
      } else {
        const change = await direct.write({
          ...body,
          draft_id: draft?.id,
          revision: draft?.revision,
          base_hash: draft?.base_hash || item?.hash,
          action: draft?.action || (item ? 'update' : 'create'),
        });
        if (change.status === 'succeeded') onDone();
      }
    } catch (e) {
      setErr(e);
    } finally {
      setPendingAction(null);
    }
  }
  const identity = (
    <Form.Item
      label={
        kind === 'plugin_metadata'
          ? t('插件名称')
          : kind === 'secrets'
            ? t('管理器:标识')
            : kind === 'credentials'
              ? t('消费者:凭据标识')
              : t('资源 ID')
      }
      required
    >
      <Input
        aria-label={t('资源 ID')}
        disabled={!!item || !!draft}
        value={id}
        onChange={(e) => {
          editVersion.current++;
          setId(e.target.value);
          setValidation(undefined);
        }}
      />
    </Form.Item>
  );
  const json = (
    <Form.Item
      label={t('完整 JSON 配置')}
      validateStatus={!obj || shapeErrors.length ? 'error' : undefined}
      help={
        !obj
          ? t('请输入有效的 JSON 对象')
          : shapeErrors.length
            ? feedback(shapeErrors[0].message)
            : undefined
      }
    >
      <Input.TextArea
        aria-label={t('完整 JSON 配置')}
        className="ops-code"
        rows={service ? 15 : 9}
        value={raw}
        onChange={(e) => update(e.target.value)}
      />
    </Form.Item>
  );
  return (
    <Form layout="vertical" component="div">
      {kind === 'secrets' && !draft && !item && (
        <Form.Item label={t('密钥管理器')}>
          <Select
            value={provider}
            options={Object.keys(providerTemplates).map((value) => ({ value }))}
            onChange={(p) => {
              setId(p + ':' + (id.split(':')[1] || ''));
              update(pretty(providerTemplates[p]));
            }}
          />
        </Form.Item>
      )}
      {service ? (
        <BufferContext.Provider value={reportBuffer}>
          <ServiceFields
            value={shapeErrors.length ? undefined : obj}
            identity={identity}
            json={json}
            resourceId={item?.id || draft?.resource_id}
            draftId={draft?.id}
            creating={creating}
            pending={!!Object.keys(buffers).length}
            onChange={(v) => update(pretty(v))}
          />
        </BufferContext.Provider>
      ) : (
        identity
      )}
      {!!formFields?.length && (
        <Space orientation="vertical" style={{ width: '100%' }}>
          {formFields.map((key) => (
            <Form.Item key={key} label={key}>
              {['content', 'cert', 'key'].includes(key) ? (
                <Input.TextArea
                  aria-label={key}
                  rows={key === 'content' ? 5 : 2}
                  disabled={!obj}
                  value={obj?.[key] ?? ''}
                  onChange={(e) => update(pretty({ ...obj, [key]: e.target.value }))}
                />
              ) : (
                <Input
                  type={
                    ['token', 'secret_access_key', 'access_key_id'].includes(key)
                      ? 'password'
                      : key === 'server_port'
                        ? 'number'
                        : 'text'
                  }
                  aria-label={key}
                  disabled={!obj}
                  value={obj?.[key] ?? ''}
                  onChange={(e) =>
                    update(
                      pretty({
                        ...obj,
                        [key]: key === 'server_port' ? Number(e.target.value) : e.target.value,
                      }),
                    )
                  }
                />
              )}
            </Form.Item>
          ))}
        </Space>
      )}
      {obj &&
        ['plugin_configs', 'global_rules', 'consumer_groups', 'credentials'].includes(kind) && (
          <PluginManager
            value={obj.plugins || {}}
            resourceType={kind}
            scope={kind === 'credentials' ? 'consumer' : 'route'}
            resourceId={item?.id || draft?.resource_id}
            draftId={draft?.id}
            onChange={(plugins) => update(pretty({ ...obj, plugins }))}
          />
        )}
      {!service && json}
      {global && (
        <Form.Item>
          <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)}>
            {t('已核对该策略在整个集群的影响')}
          </Checkbox>
        </Form.Item>
      )}
      {direct.confirmationField}
      {err ? <RequestError error={err} /> : null}
      {validation && <Checks checks={validation.checks} />}
      {validation?.preview && <DiffView {...validation.preview} />}
      {issues.length > 0 && (
        <div className="form-hint service-issues" role="status">
          {[...new Set(issues.map(feedback))].join(' · ')}
        </div>
      )}
      <Space wrap className={service ? 'service-editor-actions' : undefined}>
        <Button
          aria-label={t('校验配置')}
          aria-busy={pendingAction === 'validate'}
          disabled={!ready || pendingAction !== null}
          loading={pendingAction === 'validate'}
          onClick={() => submit(true)}
        >
          {t('校验配置')}
        </Button>
        <Button
          type="primary"
          aria-label={direct.label}
          aria-busy={pendingAction === 'write'}
          loading={pendingAction === 'write'}
          disabled={!ready || pendingAction !== null || !direct.ready || (global && !confirm)}
          onClick={() => submit(false)}
        >
          {direct.label}
        </Button>
      </Space>
    </Form>
  );
}
export function Managed({ policy }: { policy: boolean }) {
  const { clusterId } = useConsole();
  const [params] = useSearchParams();
  const kinds = policy ? policies : extended;
  const initial = params.get('kind') || '';
  const [chosen, choose] = useState('');
  const kind = kinds.includes(chosen) ? chosen : kinds.includes(initial) ? initial : kinds[0];
  const t = useTranslate();
  if (!clusterId) return <NoCluster />;
  return (
    <>
      <PageTitle
        title={policy ? t('共享策略') : t('扩展资源')}
        description={
          policy
            ? t('管理可复用的插件配置、全局规则和插件元数据。')
            : t('管理服务、协议、证书及消费者的独立资源。')
        }
      />
      <Tabs
        activeKey={kind}
        onChange={choose}
        items={kinds.map((k) => ({ key: k, label: t(kindNames[k]) }))}
      />
      <ManagedList key={clusterId + kind} kind={kind} />
    </>
  );
}
function ManagedList({ kind }: { kind: string }) {
  const { clusterId, cluster, can } = useConsole();
  const [removing, setRemoving] = useState<Resource>();
  const t = useTranslate();
  const [owner, setOwner] = useState('');
  const [edit, setEdit] = useState<Resource | 'new'>();
  const [impact, setImpact] = useState<Resource>();
  const [params] = useSearchParams();
  const [q, setQ] = useState(() => (kind === 'plugin_configs' ? params.get('resource') || '' : ''));
  const base = '/clusters/' + clusterId + '/resources/';
  const consumer = useQuery({
    queryKey: ['ops-owners', clusterId],
    queryFn: () => api<{ items: Resource[] }>(base + 'consumers'),
    enabled: kind === 'credentials',
  });
  const list = useQuery({
    queryKey: ['managed', clusterId, kind, owner],
    queryFn: () =>
      api<{ items: Resource[] }>(
        base + kind + (owner ? '?owner=' + encodeURIComponent(owner) : ''),
      ),
    enabled: kind !== 'credentials' || !!owner,
  });
  const links = useQuery({
    queryKey: ['impact', clusterId, kind, impact?.id],
    queryFn: () =>
      api<{ references: Ref[]; dependencies: Ref[] }>(
        base + kind + '/' + encodeURIComponent(impact!.id) + '/impact',
      ),
    enabled: !!impact,
  });
  const writable = kind !== 'ssls' && can('edit') && !cluster?.read_only;
  const available = !list.error && (kind !== 'credentials' || !!owner);
  return (
    <Panel
      title={t(kindNames[kind])}
      extra={
        kind !== 'ssls' && (
          <Button
            type="primary"
            disabled={!writable || !available || list.isLoading}
            onClick={() => setEdit('new')}
          >
            {t('新建配置')}
          </Button>
        )
      }
    >
      <div className="ops-tools">
        {kind === 'credentials' && (
          <Select
            aria-label={t('选择消费者')}
            placeholder={t('选择消费者')}
            showSearch
            style={{ minWidth: 200 }}
            value={owner || undefined}
            onChange={setOwner}
            options={consumer.data?.items.map((v) => ({ value: v.id }))}
          />
        )}
        <Input.Search
          allowClear
          placeholder={t('搜索资源 ID 或名称')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {kind === 'ssls' && (
        <Alert type="info" showIcon title={t('网关读取时省略私钥，证书仅供查看和目标引用。')} />
      )}
      {kind === 'global_rules' && (
        <Alert type="warning" showIcon title={t('全局规则应用于集群中的所有 HTTP 路由。')} />
      )}
      {list.error || consumer.error ? (
        <RequestError
          error={list.error || consumer.error}
          retry={() => {
            list.refetch();
          }}
        />
      ) : null}
      <Table
        rowKey="id"
        loading={list.isLoading}
        scroll={{ x: 580 }}
        dataSource={
          list.data?.items.filter((v) =>
            (v.id + ' ' + (v.value.name || '')).toLowerCase().includes(q.toLowerCase()),
          ) || []
        }
        columns={[
          { title: t('资源 ID'), dataIndex: 'id' },
          ...(kind === 'services'
            ? [
                {
                  title: t('服务名称'),
                  render: (_: unknown, r: Resource) => (
                    <div>
                      <strong>{r.value.name || '—'}</strong>
                      {r.value.desc && <div className="form-hint">{r.value.desc}</div>}
                    </div>
                  ),
                },
                {
                  title: t('上游服务'),
                  render: (_: unknown, r: Resource) =>
                    r.value.upstream_id ?? (r.value.upstream ? t('内联上游') : t('由路由提供上游')),
                },
              ]
            : []),
          {
            title: t('插件'),
            render: (_, r) => (
              <Space wrap>
                {Object.keys(r.value.plugins || {}).map((k) => (
                  <Tag key={k}>{k}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: t('操作'),
            render: (_, r) => (
              <Space wrap>
                <Button type="link" onClick={() => setImpact(r)}>
                  {t('查看配置与引用')}
                </Button>
                <Button autoInsertSpace={false} disabled={!writable} onClick={() => setEdit(r)}>
                  {t('编辑')}
                </Button>
                <Button
                  autoInsertSpace={false}
                  disabled={!writable}
                  danger
                  onClick={() => setRemoving(r)}
                >
                  {t('删除')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {removing && (
        <RouteActionDialog
          action={{ type: 'delete', route: removing, kind }}
          close={() => setRemoving(undefined)}
        />
      )}
      <Drawer
        title={t('查看配置与引用')}
        open={!!impact}
        onClose={() => setImpact(undefined)}
        size="large"
      >
        {impact && (
          <Space orientation="vertical">
            <strong>{impact.id}</strong>
            <h3>{t('引用此资源')}</h3>
            {links.error ? (
              <RequestError error={links.error} />
            ) : (
              <RefList items={links.data?.references || []} />
            )}
            <h3>{t('资源依赖')}</h3>
            <RefList items={links.data?.dependencies || []} />
            <pre className="ops-preview">{pretty(impact.value)}</pre>
          </Space>
        )}
      </Drawer>
      <Modal
        open={!!edit}
        title={t(kindNames[kind]) + ' · ' + t('配置编辑')}
        onCancel={() => setEdit(undefined)}
        footer={null}
        width={kind === 'services' ? 920 : 720}
        destroyOnHidden
      >
        {edit && (
          <ManagedEditor
            kind={kind}
            item={edit === 'new' ? undefined : edit}
            owner={owner}
            onDone={() => setEdit(undefined)}
          />
        )}
      </Modal>
    </Panel>
  );
}

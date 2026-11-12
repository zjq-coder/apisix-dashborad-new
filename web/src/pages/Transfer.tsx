import { useConfigWrite } from '../useConfigWrite';
import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Select, Space, Table, Tag } from 'antd';
import { api, post } from '../api';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import { NoCluster, PageTitle, Panel, RequestError } from '../components/Common';
import { RefList, type Ref } from './Managed';
import { RouteImportFields } from './RouteTools';
import { kindNames, pretty, type Resource, type JsonObject, type Difference } from '../types';

interface Bundle {
  format: string;
  items: (Ref & { value: JsonObject })[];
}
interface Preview {
  ready: boolean;
  token: string;
  rows: (Ref & { action: string; namesakes?: string[]; diff: Difference[]; dependencies: Ref[] })[];
}
const portable = ['routes', 'services', 'upstreams', 'plugin_configs', 'protos', 'stream_routes'];
const actions: Record<string, string> = {
  create: '新增',
  update: '修改',
  same: '相同',
  reuse: '复用',
  conflict: '资源冲突',
};
const signature = (r: Ref) => r.kind + '/' + r.id;
export function Transfer({ routeImport = false }: { routeImport?: boolean }) {
  const { clusterId } = useConsole();
  return clusterId ? (
    <TransferForm key={clusterId + routeImport} routeImport={routeImport} />
  ) : (
    <NoCluster />
  );
}
function TransferForm({ routeImport }: { routeImport: boolean }) {
  const { clusterId, clusters, cluster, go } = useConsole();
  const t = useTranslate();
  const [target, setTarget] = useState(
    (!routeImport && clusters.find((c) => c.id !== clusterId)?.id) || clusterId,
  );
  const [kind, setKind] = useState('routes');
  const [roots, setRoots] = useState<string[]>([]);
  const [raw, setRaw] = useState('');
  const [mappings, setMappings] = useState({ ids: '{}', hosts: '{}', nodes: '{}' });
  const [strategies, setStrategies] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [saved, setSaved] = useState('');
  const targetCluster = clusters.find((c) => c.id === target);
  const direct = useConfigWrite(targetCluster);
  const file = useRef<HTMLInputElement>(null);
  const source = useQuery({
    queryKey: ['transfer-source', clusterId, kind],
    enabled: !routeImport,
    queryFn: () => api<{ items: Resource[] }>('/clusters/' + clusterId + '/resources/' + kind),
  });
  const revision = useRef(0);
  const invalidate = () => {
    revision.current++;
    setPreview(undefined);
    setErr(undefined);
    setSaved('');
  };
  function setBundle(b: string) {
    invalidate();
    setRaw(b);
    setStrategies({});
    setMappings({ ids: '{}', hosts: '{}', nodes: '{}' });
  }
  let bundle: Bundle | undefined;
  try {
    const value = JSON.parse(raw);
    if (
      value.format === 'apisix-dashboard/v1' &&
      Array.isArray(value.items) &&
      value.items.length > 0 &&
      value.items.every((i: Ref) => i && portable.includes(i.kind) && typeof i.id === 'string')
    )
      bundle = value;
  } catch {
    /* Edited files may be incomplete. */
  }
  async function run(fn: () => Promise<void>) {
    setErr(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  function loadSource() {
    return run(async () => {
      const refs = roots.map((v) => {
        const [kind, id] = v.split('/');
        return { kind, id };
      });
      setBundle(pretty(await post('/clusters/' + clusterId + '/export', { roots: refs })));
    });
  }
  function download() {
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'apisix-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function compare(stage = false) {
    const version = revision.current;
    return run(async () => {
      const body = {
        bundle,
        strategies,
        ids: JSON.parse(mappings.ids),
        hosts: JSON.parse(mappings.hosts),
        nodes: JSON.parse(mappings.nodes),
      };
      const base = '/clusters/' + target + '/transfer/';
      if (stage) {
        const out = await direct.write(
          {
            ...body,
            token: preview?.token,
          },
          'transfer',
        );
        if (version === revision.current) {
          if (out.status === 'succeeded') setSaved(out.id);
          setPreview(undefined);
        }
      } else {
        setPreview(undefined);
        const result = await post<Preview>(base + 'preview', body);
        if (version === revision.current) setPreview(result);
      }
    });
  }
  return (
    <>
      <PageTitle
        title={routeImport ? t('导入 OpenAPI') : t('环境迁移')}
        description={
          routeImport
            ? t('解析文件并预览差异，一次发布选中的路由。')
            : t('选择源资源及依赖，核对差异后发布到目标环境。')
        }
      />
      <div className="ops-stack">
        <Panel title={routeImport ? t('路由文件') : t('源配置包')}>
          <div className="ops-body">
            {routeImport ? (
              <RouteImportFields setBundle={setBundle} busy={busy} />
            ) : (
              <Form layout="vertical">
                <Form.Item label={t('源环境')}>
                  <Tag>{cluster?.name}</Tag>
                </Form.Item>
                <div className="ops-grid">
                  <Select
                    aria-label={t('资源类型')}
                    value={kind}
                    onChange={setKind}
                    options={portable.map((v) => ({ value: v, label: t(kindNames[v]) }))}
                  />
                  <Select
                    mode="multiple"
                    aria-label={t('选择源资源')}
                    placeholder={t('选择源资源')}
                    value={roots}
                    onChange={(v) => {
                      setRoots(v);
                      setBundle('');
                    }}
                    options={Array.from(
                      new Set([
                        ...roots,
                        ...(source.data?.items || []).map((v) => kind + '/' + v.id),
                      ]),
                    ).map((value) => ({ value }))}
                  />
                </div>
                {source.error && <RequestError error={source.error} />}
                <Space wrap>
                  <Button disabled={!roots.length || busy} onClick={loadSource}>
                    {t('读取资源及依赖')}
                  </Button>
                  <Button disabled={busy} onClick={() => file.current?.click()}>
                    {t('导入 JSON 文件')}
                  </Button>
                  <Button disabled={!bundle || busy} onClick={download}>
                    {t('导出配置包')}
                  </Button>
                </Space>
                <input
                  hidden
                  type="file"
                  accept=".json,application/json"
                  ref={file}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f)
                      run(async () => {
                        if (f.size > 2 * 1024 * 1024) throw Error(t('文件超过 2 MiB'));
                        setBundle(await f.text());
                      });
                  }}
                />
                {raw && (
                  <Form.Item label={t('配置包内容')}>
                    <Input.TextArea
                      className="ops-code"
                      aria-label={t('配置包内容')}
                      value={raw}
                      rows={6}
                      onChange={(e) => {
                        invalidate();
                        setRaw(e.target.value);
                      }}
                    />
                    {!bundle && <Alert type="error" title={t('配置包格式无效')} />}
                  </Form.Item>
                )}
              </Form>
            )}
          </div>
        </Panel>
        {bundle && (
          <Panel title={t('目标环境与映射')}>
            <div className="ops-body">
              <Form layout="vertical">
                <Form.Item label={t('目标环境')}>
                  <Select
                    aria-label={t('目标环境')}
                    disabled={busy}
                    value={target}
                    onChange={(v) => {
                      invalidate();
                      setTarget(v);
                    }}
                    options={clusters.map((c) => ({ value: c.id, label: c.name }))}
                  />
                </Form.Item>
                <div className="ops-grid">
                  {Object.entries(mappings).map(([k, value]) => (
                    <Form.Item
                      key={k}
                      label={t(
                        (
                          {
                            ids: '资源 ID 映射',
                            hosts: '路由域名映射',
                            nodes: '上游节点映射',
                          } as Record<string, string>
                        )[k],
                      )}
                      extra={
                        k === 'ids'
                          ? '{"services/source":"target"}'
                          : k === 'hosts'
                            ? '{"dev.example":"stage.example"}'
                            : '{"dev:80":"stage:8080"}'
                      }
                    >
                      <Input.TextArea
                        rows={2}
                        className="ops-code"
                        value={value}
                        onChange={(e) => {
                          invalidate();
                          setMappings({ ...mappings, [k]: e.target.value });
                        }}
                      />
                    </Form.Item>
                  ))}
                </div>
                <Table
                  rowKey={signature}
                  size="small"
                  pagination={false}
                  dataSource={bundle.items}
                  columns={[
                    { title: t('源资源'), render: (_, v) => signature(v) },
                    {
                      title: t('冲突处理'),
                      render: (_, v) => (
                        <Select
                          style={{ minWidth: 165 }}
                          aria-label={signature(v)}
                          value={strategies[signature(v)] || ''}
                          options={[
                            { value: '', label: t('有差异时阻止') },
                            { value: 'create', label: t('允许新建同名资源') },
                            { value: 'reuse', label: t('复用目标配置') },
                            { value: 'overwrite', label: t('覆盖目标配置') },
                          ]}
                          onChange={(x) => {
                            invalidate();
                            setStrategies({ ...strategies, [signature(v)]: x });
                          }}
                        />
                      ),
                    },
                  ]}
                />
                <Button type="primary" loading={busy} onClick={() => compare()}>
                  {t('预览目标差异')}
                </Button>
              </Form>
            </div>
          </Panel>
        )}
        {err ? <RequestError error={err} /> : null}
        {preview && (
          <Panel title={t('目标差异')}>
            <div className="ops-body">
              <Table
                size="small"
                scroll={{ x: 540 }}
                rowKey={signature}
                pagination={false}
                dataSource={preview.rows}
                expandable={{
                  expandedRowRender: (r) => <pre className="ops-preview">{pretty(r.diff)}</pre>,
                }}
                columns={[
                  {
                    title: t('目标资源'),
                    render: (_, r) => (
                      <>
                        {signature(r)}
                        {!!r.namesakes?.length && (
                          <div>
                            {t('同名目标 ID')} · {r.namesakes.join(', ')}
                          </div>
                        )}
                      </>
                    ),
                  },
                  {
                    title: t('操作'),
                    render: (_, r) => (
                      <Tag color={r.action === 'conflict' ? 'orange' : 'blue'}>
                        {t(actions[r.action])}
                      </Tag>
                    ),
                  },
                  { title: t('资源依赖'), render: (_, r) => <RefList items={r.dependencies} /> },
                ]}
              />
              {direct.confirmationField}
              <Button
                type="primary"
                disabled={
                  !preview.ready ||
                  !preview.rows.some((r) => r.action === 'create' || r.action === 'update') ||
                  !!saved.length ||
                  !targetCluster ||
                  !direct.ready
                }
                loading={busy}
                onClick={() => compare(true)}
              >
                {direct.publish ? t('批量发布') : direct.label}
              </Button>
            </div>
          </Panel>
        )}
        {!!saved.length && (
          <Alert
            showIcon
            type="success"
            title={t('配置已发布到「{0}」', targetCluster?.name || '')}
            action={
              <Button onClick={() => go('/changes/' + saved, target)}>{t('查看发布记录')}</Button>
            }
          />
        )}
      </div>
    </>
  );
}

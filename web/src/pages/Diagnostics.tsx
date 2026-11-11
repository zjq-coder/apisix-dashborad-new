import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Form, Input, Select, Space, Table, Tag } from 'antd';
import { api } from '../api';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import { NoCluster, PageTitle, Panel, RequestError } from '../components/Common';
import { routeCandidates } from '../routeCandidates';
import type { Resource } from '../types';
export function Diagnostics() {
  const { clusterId } = useConsole();
  return clusterId ? <DiagnosticForm key={clusterId} /> : <NoCluster />;
}
function DiagnosticForm() {
  const { clusterId } = useConsole();
  const t = useTranslate();
  const [input, setInput] = useState({ method: 'GET', host: '', path: '/' });
  const [submitted, setSubmitted] = useState<typeof input>();
  const config = useQuery({
    queryKey: ['diagnostic', clusterId],
    enabled: false,
    queryFn: async () => {
      const load = (k: string) =>
        api<{ items: Resource[] }>('/clusters/' + clusterId + '/resources/' + k).then(
          (v) => v.items,
        );
      const [routes, services, plugins, upstreams, global] = await Promise.all(
        ['routes', 'services', 'plugin_configs', 'upstreams', 'global_rules'].map(load),
      );
      return { routes, services, plugins, upstreams, global };
    },
  });
  const data = config.data;
  const rows =
    data && submitted
      ? routeCandidates(data.routes, submitted.method, submitted.host, submitted.path)
      : [];
  return (
    <>
      <PageTitle
        title={t('配置诊断')}
        description={t(
          '按方法、域名和路径分析候选路由。结果来自已发布配置，运行时条件需另行核实。',
        )}
      />
      <div className="ops-stack">
        <Panel title={t('请求匹配条件')}>
          <Form
            className="ops-body"
            layout="vertical"
            onFinish={() => {
              setSubmitted({ ...input });
              config.refetch();
            }}
          >
            <div className="ops-grid">
              <Form.Item label={t('请求方法')}>
                <Select
                  value={input.method}
                  options={[
                    'GET',
                    'POST',
                    'PUT',
                    'PATCH',
                    'DELETE',
                    'HEAD',
                    'OPTIONS',
                    'CONNECT',
                    'TRACE',
                  ].map((value) => ({ value }))}
                  onChange={(method) => setInput({ ...input, method })}
                />
              </Form.Item>
              <Form.Item label={t('请求域名')}>
                <Input
                  value={input.host}
                  placeholder="api.example.org"
                  onChange={(e) => setInput({ ...input, host: e.target.value })}
                />
              </Form.Item>
              <Form.Item label={t('请求路径')}>
                <Input
                  aria-label={t('请求路径')}
                  value={input.path}
                  onChange={(e) => setInput({ ...input, path: e.target.value })}
                />
              </Form.Item>
            </div>
            <Button
              type="primary"
              htmlType="submit"
              disabled={!input.path.startsWith('/')}
              loading={config.isFetching}
            >
              {t('分析路由')}
            </Button>
          </Form>
        </Panel>
        {config.error ? (
          <RequestError error={config.error} />
        ) : (
          submitted &&
          data && (
            <Panel title={t('候选路由')}>
              <Table
                rowKey="id"
                scroll={{ x: 700 }}
                dataSource={rows}
                columns={[
                  {
                    title: t('路由'),
                    render: (_, r) => (
                      <>
                        <strong>{r.name}</strong>
                        {r.name !== r.id && <div className="muted">{r.id}</div>}
                        <div>{r.match}</div>
                      </>
                    ),
                  },
                  { title: t('优先级'), dataIndex: 'priority' },
                  {
                    title: t('转发与插件'),
                    render: (_, r) => {
                      const service = data.services.find((s) => s.id === r.service);
                      const shared = data.plugins.find((p) => p.id === r.config);
                      const upstream = r.upstream || (!r.inline && service?.value.upstream_id);
                      return (
                        <Space orientation="vertical">
                          <span>
                            {[
                              r.service && 'services/' + r.service,
                              upstream
                                ? 'upstreams/' + upstream
                                : r.inline || service?.value.upstream
                                  ? t('内联上游')
                                  : '',
                            ]
                              .filter(Boolean)
                              .join(' → ') || '—'}
                          </span>
                          {((r.service && !service) ||
                            (r.config && !shared) ||
                            (upstream && !data.upstreams.some((u) => u.id === upstream))) && (
                            <Tag color="red">{t('缺失依赖')}</Tag>
                          )}
                          <Space wrap>
                            {Array.from(
                              new Set([
                                ...r.plugins,
                                ...Object.keys(service?.value.plugins || {}),
                                ...Object.keys(shared?.value.plugins || {}),
                                ...data.global.flatMap((g) => Object.keys(g.value.plugins || {})),
                              ]),
                            ).map((k) => (
                              <Tag key={k}>{k}</Tag>
                            ))}
                          </Space>
                        </Space>
                      );
                    },
                  },
                  {
                    title: t('待核实条件'),
                    render: (_, r) => (r.conditions.length ? r.conditions.join(', ') : '—'),
                  },
                ]}
              />
            </Panel>
          )
        )}
      </div>
    </>
  );
}

import { useFeedback } from '../i18n/feedback';
import { translate, useTranslate } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Form, Input, InputNumber, Select, Switch } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Panel } from '../components/Common';
import { patchField } from '../config';
import type { JsonObject } from '../types';
import { JsonField, NumberField, StringListField, ToggleSetting, useBuffer } from './Fields';
import { nestedField, nodeRows, parseNodeAddress, serializeNodes, type NodeRow } from './config';

function Nodes({
  value,
  onChange,
  readOnly,
}: {
  value: JsonObject;
  onChange: (next: JsonObject) => void;
  readOnly: boolean;
}) {
  const feedback = useFeedback();
  const t = useTranslate();
  const [rows, setRows] = useState(() => nodeRows(value));
  const [error, setError] = useState('');
  const report = useBuffer('upstream.nodes');
  const serialized = JSON.stringify(value.nodes);
  const last = useRef(serialized);
  useEffect(() => {
    if (last.current !== serialized) {
      last.current = serialized;
      setRows(nodeRows(value));
      setError('');
      report('');
    }
  }, [serialized]);
  const change = (next: NodeRow[]) => {
    setRows(next);
    const invalid = next.findIndex(
      (row) =>
        !parseNodeAddress(row.address.trim()) ||
        row.weight === null ||
        !Number.isInteger(row.weight) ||
        row.weight < 0,
    );
    const message =
      invalid !== -1
        ? translate('zh-CN', '请填写第 {0} 个节点的有效地址和非负整数权重', invalid + 1)
        : new Set(next.map((row) => row.address.trim())).size !== next.length
          ? '节点地址不能重复'
          : '';
    setError(message);
    report(message);
    if (!message) {
      const nodes = serializeNodes(
        next.map((row) => ({ ...row, address: row.address.trim() })),
        Array.isArray(value.nodes),
      );
      last.current = JSON.stringify(nodes);
      onChange({ ...value, nodes });
    }
  };
  return (
    <div className="field-collection">
      <div className="advanced-node-row node-label-row">
        <span>{t('节点地址 · host:port')}</span>
        <span>{t('权重')}</span>
        <span>{t('优先级')}</span>
        <span />
      </div>
      {rows.map((row, i) => (
        <div className="advanced-node-row" key={i}>
          <Input
            aria-label={t('节点地址 {0}', i + 1)}
            className="mono"
            value={row.address}
            placeholder={t('echo:80 或 [::1]:8080')}
            disabled={readOnly}
            onChange={(event) =>
              change(
                rows.map((old, j) => (i === j ? { ...old, address: event.target.value } : old)),
              )
            }
          />
          <InputNumber
            aria-label={t('节点权重 {0}', i + 1)}
            value={row.weight}
            min={0}
            precision={0}
            disabled={readOnly}
            onChange={(weight) =>
              change(rows.map((old, j) => (i === j ? { ...old, weight } : old)))
            }
          />
          <InputNumber
            aria-label={t('节点优先级 {0}', i + 1)}
            value={row.extra.priority}
            precision={0}
            placeholder="0"
            disabled={readOnly}
            onChange={(priority) =>
              change(
                rows.map((old, j) =>
                  i === j ? { ...old, extra: patchField(old.extra, 'priority', priority) } : old,
                ),
              )
            }
          />
          <Button
            type="text"
            danger
            disabled={readOnly}
            icon={<DeleteOutlined aria-hidden="true" />}
            aria-label={t('移除节点 {0}', i + 1)}
            onClick={() => change(rows.filter((_, j) => i !== j))}
          />
        </div>
      ))}
      <Button
        type="dashed"
        block
        disabled={readOnly}
        icon={<PlusOutlined aria-hidden="true" />}
        onClick={() => change([...rows, { address: '', weight: 1, extra: {} }])}
      >
        {t('添加节点')}
      </Button>
      {error && (
        <div className="field-error" role="alert">
          {feedback(error)}
        </div>
      )}
      <p className="form-hint">
        {t(
          '权重 0 不参与正常分流；较低优先级节点用于故障切换。设置节点优先级后使用 APISIX 数组格式，其他节点字段会保留。',
        )}
      </p>
    </div>
  );
}

function StatusCodes({
  scope,
  value = [],
  onChange,
  label,
}: {
  scope: string;
  value?: number[];
  onChange: (value: number[]) => void;
  label: string;
}) {
  const feedback = useFeedback();
  const [items, setItems] = useState(value.map(String));
  const [error, setError] = useState('');
  const report = useBuffer(scope);
  const serialized = JSON.stringify(value);
  const last = useRef(serialized);
  useEffect(() => {
    if (last.current !== serialized) {
      last.current = serialized;
      setItems(value.map(String));
      setError('');
      report('');
    }
  }, [serialized]);
  return (
    <Form.Item
      label={label}
      validateStatus={error ? 'error' : undefined}
      help={feedback(error) || undefined}
    >
      <Select
        mode="tags"
        aria-label={label}
        value={items}
        allowClear
        tokenSeparators={[',']}
        options={[200, 201, 204, 301, 302, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504].map(
          (code) => ({ value: String(code) }),
        )}
        onChange={(next) => {
          setItems(next);
          const message = next.some(
            (code) => !/^\d{3}$/.test(code) || Number(code) < 100 || Number(code) > 599,
          )
            ? '状态码须为 100–599 的整数'
            : '';
          setError(message);
          report(message);
          if (!message) {
            const output = next.map(Number);
            last.current = JSON.stringify(output);
            onChange(output);
          }
        }}
      />
    </Form.Item>
  );
}

function HealthCheck({
  value,
  onChange,
  active,
  readOnly,
}: {
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  active: boolean;
  readOnly: boolean;
}) {
  const t = useTranslate();
  const prefix = active ? t('主动') : t('被动');
  const field = (name: string, next: unknown) => onChange(patchField(value, name, next));
  const codes = (state: string) => (
    <StatusCodes
      scope={`upstream.checks.${active ? 'active' : 'passive'}.${state}.http_statuses`}
      label={t('{0}{1}状态码', prefix, state === 'healthy' ? t('健康') : t('异常'))}
      value={value[state]?.http_statuses}
      onChange={(next) =>
        onChange(nestedField(value, state, 'http_statuses', next.length ? next : undefined))
      }
    />
  );
  return (
    <div className="health-check-fields">
      <div className="form-three">
        <Form.Item label={t('{0}检查类型', prefix)}>
          <Select
            aria-label={t('{0}检查类型', prefix)}
            value={value.type || 'http'}
            onChange={(next) => field('type', next)}
            options={['http', 'https', 'tcp'].map((v) => ({ value: v, label: v.toUpperCase() }))}
          />
        </Form.Item>
        {active && (
          <>
            <NumberField
              label={t('检查超时（秒）')}
              value={value.timeout}
              min={0.001}
              onChange={(next) => field('timeout', next)}
            />
            <NumberField
              label={t('检查并发数')}
              value={value.concurrency}
              min={1}
              integer
              onChange={(next) => field('concurrency', next)}
            />
          </>
        )}
      </div>
      {active && (
        <>
          <div className="form-two">
            <Form.Item label={t('检查 Host')}>
              <Input
                aria-label={t('检查 Host')}
                value={value.host}
                placeholder={t('默认使用节点地址')}
                onChange={(e) => field('host', e.target.value)}
              />
            </Form.Item>
            <NumberField
              label={t('检查端口')}
              value={value.port}
              min={1}
              max={65535}
              integer
              onChange={(next) => field('port', next)}
            />
          </div>
          {value.type !== 'tcp' && (
            <>
              <Form.Item label={t('检查路径')}>
                <Input
                  aria-label={t('检查路径')}
                  value={value.http_path}
                  placeholder="/health"
                  onChange={(e) => field('http_path', e.target.value)}
                />
              </Form.Item>
              <Form.Item
                label={t('健康检查请求头')}
                extra={t('每项为一行，例如 X-Health-Check: true')}
              >
                <StringListField
                  label={t('检查请求头')}
                  scope="upstream.health.headers"
                  value={value.req_headers || []}
                  onChange={(next) => field('req_headers', next.length ? next : undefined)}
                  readOnly={readOnly}
                />
              </Form.Item>
            </>
          )}
          {value.type === 'https' && (
            <Form.Item label={t('验证 HTTPS 证书')}>
              <Switch
                aria-label={t('验证检查证书')}
                checked={value.https_verify !== false}
                onChange={(next) => field('https_verify', next)}
              />
            </Form.Item>
          )}
        </>
      )}
      <div className="health-state-grid">
        <div className="health-state">
          <h4>
            <i className="tiny-dot" />
            {t('健康阈值')}
          </h4>
          {active && (
            <NumberField
              label={t('{0}健康检查间隔（秒）', prefix)}
              value={value.healthy?.interval}
              onChange={(next) => onChange(nestedField(value, 'healthy', 'interval', next))}
            />
          )}
          <NumberField
            label={t('{0}恢复成功次数', prefix)}
            value={value.healthy?.successes}
            integer
            onChange={(next) => onChange(nestedField(value, 'healthy', 'successes', next))}
          />
          {value.type !== 'tcp' && codes('healthy')}
        </div>
        <div className="health-state">
          <h4>
            <i className="health-warning-dot" />
            {t('异常阈值')}
          </h4>
          {active && (
            <NumberField
              label={t('{0}异常检查间隔（秒）', prefix)}
              value={value.unhealthy?.interval}
              onChange={(next) => onChange(nestedField(value, 'unhealthy', 'interval', next))}
            />
          )}
          <div className="form-two">
            <NumberField
              label={t('{0}超时次数', prefix)}
              value={value.unhealthy?.timeouts}
              integer
              onChange={(next) => onChange(nestedField(value, 'unhealthy', 'timeouts', next))}
            />
            <NumberField
              label={t('{0}TCP 失败次数', prefix)}
              value={value.unhealthy?.tcp_failures}
              integer
              onChange={(next) => onChange(nestedField(value, 'unhealthy', 'tcp_failures', next))}
            />
          </div>
          {value.type !== 'tcp' && (
            <>
              <NumberField
                label={t('{0}HTTP 失败次数', prefix)}
                value={value.unhealthy?.http_failures}
                integer
                onChange={(next) =>
                  onChange(nestedField(value, 'unhealthy', 'http_failures', next))
                }
              />
              {codes('unhealthy')}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function UpstreamFields({
  value,
  onChange,
  readOnly = false,
}: {
  value: JsonObject;
  onChange: (next: JsonObject) => void;
  readOnly?: boolean;
}) {
  const t = useTranslate();
  const field = (key: string, next: unknown) => onChange(patchField(value, key, next));
  const discovery = !!value.discovery_type;
  return (
    <div className="upstream-fields">
      <Panel title={t('负载均衡与节点')}>
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <div className="form-two">
            <Form.Item label={t('负载均衡算法')}>
              <Select
                aria-label={t('负载均衡算法')}
                value={value.type || 'roundrobin'}
                options={[
                  { value: 'roundrobin', label: t('带权轮询 · Round Robin') },
                  { value: 'chash', label: t('一致性哈希 · Chash') },
                  { value: 'ewma', label: t('延迟加权 · EWMA') },
                  { value: 'least_conn', label: t('最少连接 · Least Conn') },
                ]}
                onChange={(next) => field('type', next)}
              />
            </Form.Item>
            <Form.Item label={t('上游协议')}>
              <Select
                aria-label={t('上游协议')}
                value={value.scheme || 'http'}
                options={['http', 'https', 'grpc', 'grpcs'].map((scheme) => ({
                  value: scheme,
                  label: scheme.toUpperCase(),
                }))}
                onChange={(next) => field('scheme', next)}
              />
            </Form.Item>
          </div>
          {value.type === 'chash' && (
            <div className="form-two">
              <Form.Item label={t('哈希来源')}>
                <Select
                  aria-label={t('哈希来源')}
                  value={value.hash_on || 'vars'}
                  onChange={(next) => field('hash_on', next)}
                  options={[
                    { value: 'vars', label: t('Nginx 变量') },
                    { value: 'header', label: t('HTTP 请求头') },
                    { value: 'cookie', label: 'Cookie' },
                    { value: 'consumer', label: t('消费者') },
                    { value: 'vars_combinations', label: t('变量组合') },
                  ]}
                />
              </Form.Item>
              {value.hash_on !== 'consumer' && (
                <Form.Item label={t('哈希键')} required>
                  <Input
                    aria-label={t('哈希键')}
                    value={value.key}
                    placeholder="remote_addr"
                    onChange={(e) => field('key', e.target.value)}
                  />
                </Form.Item>
              )}
            </div>
          )}
          <Form.Item label={t('节点来源')}>
            <Select
              aria-label={t('节点来源')}
              value={discovery ? 'discovery' : 'nodes'}
              options={[
                { value: 'nodes', label: t('静态节点') },
                { value: 'discovery', label: t('服务发现') },
              ]}
              onChange={(next) => {
                const config = { ...value };
                if (next === 'discovery') {
                  delete config.nodes;
                  config.discovery_type = 'dns';
                  config.service_name = '';
                } else {
                  delete config.discovery_type;
                  delete config.service_name;
                  delete config.discovery_args;
                  config.nodes = {};
                }
                onChange(config);
              }}
            />
          </Form.Item>
          {discovery ? (
            <>
              <div className="form-two">
                <Form.Item label={t('服务发现类型')} required>
                  <Input
                    aria-label={t('服务发现类型')}
                    value={value.discovery_type}
                    onChange={(e) => field('discovery_type', e.target.value)}
                    placeholder="nacos / consul / dns"
                  />
                </Form.Item>
                <Form.Item label={t('服务名称')} required>
                  <Input
                    aria-label={t('服务名称')}
                    value={value.service_name}
                    onChange={(e) => field('service_name', e.target.value)}
                  />
                </Form.Item>
              </div>
              <Alert
                type="info"
                showIcon
                title={t('需要先在目标 APISIX 中配置对应的服务发现组件。')}
              />
              <Collapse
                ghost
                items={[
                  {
                    key: 'args',
                    label: t('服务发现参数'),
                    children: (
                      <JsonField
                        label={t('服务发现参数 JSON')}
                        value={value.discovery_args || {}}
                        onChange={(next) => field('discovery_args', next)}
                        scope="upstream.discovery_args"
                        kind="object"
                        readOnly={readOnly}
                      />
                    ),
                  },
                ]}
              />
            </>
          ) : (
            <Nodes value={value} onChange={onChange} readOnly={readOnly} />
          )}
        </Form>
      </Panel>
      <Panel title={t('连接策略')}>
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <div className="form-three">
            {[
              { key: 'connect', label: t('连接超时（秒）') },
              { key: 'send', label: t('发送超时（秒）') },
              { key: 'read', label: t('读取超时（秒）') },
            ].map(({ key, label }) => (
              <NumberField
                key={key}
                label={label}
                value={value.timeout?.[key]}
                onChange={(next) => onChange(nestedField(value, 'timeout', key, next))}
              />
            ))}
          </div>
          <div className="form-two">
            <NumberField
              label={t('重试次数')}
              value={value.retries}
              integer
              onChange={(next) => field('retries', next)}
              extra={t('0 表示不重试，留空使用网关默认值。')}
            />
            <NumberField
              label={t('重试总超时（秒）')}
              value={value.retry_timeout}
              onChange={(next) => field('retry_timeout', next)}
              extra={t('0 表示不限制重试总超时。')}
            />
          </div>
          <div className="form-two">
            <Form.Item label={t('转发 Host')}>
              <Select
                aria-label={t('转发 Host')}
                value={value.pass_host || 'pass'}
                onChange={(next) => field('pass_host', next)}
                options={[
                  { value: 'pass', label: t('保留客户端 Host') },
                  { value: 'node', label: t('使用节点 Host') },
                  { value: 'rewrite', label: t('指定 Host') },
                ]}
              />
            </Form.Item>
            {value.pass_host === 'rewrite' && (
              <Form.Item label={t('指定上游 Host')} required>
                <Input
                  aria-label={t('指定上游 Host')}
                  value={value.upstream_host}
                  onChange={(e) => field('upstream_host', e.target.value)}
                />
              </Form.Item>
            )}
          </div>
          <ToggleSetting
            label={t('自定义连接池')}
            description={t('独立设置连接复用容量、空闲时间和单连接请求上限。')}
            value={!!value.keepalive_pool}
            disabled={readOnly}
            onChange={(enabled) =>
              field(
                'keepalive_pool',
                enabled ? { size: 320, idle_timeout: 60, requests: 1000 } : undefined,
              )
            }
          />
          {value.keepalive_pool && (
            <div className="form-three setting-body">
              {[
                { key: 'size', label: t('连接池容量') },
                { key: 'idle_timeout', label: t('空闲超时（秒）') },
                { key: 'requests', label: t('单连接请求上限') },
              ].map(({ key, label }) => (
                <NumberField
                  key={key}
                  label={label}
                  value={value.keepalive_pool[key]}
                  integer={key !== 'idle_timeout'}
                  onChange={(next) => onChange(nestedField(value, 'keepalive_pool', key, next))}
                />
              ))}
            </div>
          )}
        </Form>
      </Panel>
      <Panel title={t('健康检查')}>
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <ToggleSetting
            label={t('主动健康检查')}
            description={t('周期性请求上游节点，检测异常并判断节点恢复。')}
            value={!!value.checks?.active}
            disabled={readOnly}
            onChange={(enabled) =>
              onChange(
                nestedField(
                  value,
                  'checks',
                  'active',
                  enabled
                    ? {
                        type: 'http',
                        http_path: '/health',
                        timeout: 1,
                        concurrency: 10,
                        healthy: { interval: 5, successes: 2, http_statuses: [200, 302] },
                        unhealthy: {
                          interval: 5,
                          http_failures: 3,
                          tcp_failures: 2,
                          timeouts: 3,
                          http_statuses: [429, 500, 502, 503, 504],
                        },
                      }
                    : undefined,
                ),
              )
            }
          />
          {value.checks?.active && (
            <HealthCheck
              active
              value={value.checks.active}
              readOnly={readOnly}
              onChange={(next) => onChange(nestedField(value, 'checks', 'active', next))}
            />
          )}
          <ToggleSetting
            label={t('被动健康检查')}
            description={t('根据实际转发请求的结果标记异常节点，配合主动检查恢复。')}
            value={!!value.checks?.passive}
            disabled={readOnly}
            onChange={(enabled) =>
              onChange(
                nestedField(
                  value,
                  'checks',
                  'passive',
                  enabled
                    ? {
                        type: 'http',
                        healthy: { successes: 2, http_statuses: [200, 201, 204] },
                        unhealthy: {
                          http_failures: 3,
                          tcp_failures: 2,
                          timeouts: 3,
                          http_statuses: [429, 500, 502, 503, 504],
                        },
                      }
                    : undefined,
                ),
              )
            }
          />
          {value.checks?.passive && (
            <HealthCheck
              active={false}
              value={value.checks.passive}
              readOnly={readOnly}
              onChange={(next) => onChange(nestedField(value, 'checks', 'passive', next))}
            />
          )}
        </Form>
      </Panel>
    </div>
  );
}

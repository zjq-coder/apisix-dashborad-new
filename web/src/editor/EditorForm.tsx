import { languageFooter } from '../components/LanguageSwitch';
import { useFeedback } from '../i18n/feedback';
import { useTranslate } from '../i18n';
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Tabs,
  Tag,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  FileTextOutlined,
  SaveOutlined,
  SafetyOutlined,
  ApartmentOutlined,
  SwapOutlined,
  BlockOutlined,
  AimOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBeforeUnload, useBlocker } from 'react-router-dom';
import { api, post } from '../api';
import { useConsole } from '../context';
import { Checks, Loading, PageTitle, Panel, RequestError } from '../components/Common';
import { PluginManager } from '../components/PluginManager';
import { ConfigPreview } from '../components/ConfigPreview';
import { cleanConfig, patchField } from '../config';
import {
  kindNames,
  pretty,
  type Draft,
  type JsonObject,
  type Resource,
  type ResourceKind,
  type Validation,
} from '../types';
import { BufferContext, KeyValueFields, ToggleSetting } from './Fields';
import { RouteMatchFields } from './RouteMatchFields';
import { UpstreamFields } from './UpstreamFields';
import { SharedPluginReference } from './SharedPluginReference';
import { TrafficFields } from './TrafficFields';
import { ConsumerFields } from './ConsumerFields';
import { maskPluginSecrets, type PluginDefinition } from '../plugins';
import {
  formTypeErrors,
  matchValues,
  validateConfig,
  type ConfigIssue,
  type EditorSection,
} from './config';

const CodeEditor = lazy(() => import('../components/CodeEditor'));
function targetOf(value: JsonObject, fresh: boolean) {
  return value.upstream
    ? 'inline'
    : value.upstream_id
      ? 'reference'
      : value.service_id
        ? 'service'
        : fresh
          ? 'reference'
          : 'none';
}
export function EditorForm({
  kind,
  resource,
  draft,
  copying,
}: {
  kind: ResourceKind;
  resource?: Resource;
  draft?: Draft;
  copying: boolean;
}) {
  const feedback = useFeedback();
  const t = useTranslate();
  const { cluster, clusterId, go, can } = useConsole();
  const client = useQueryClient();
  const { message } = App.useApp();
  const action = draft?.action || (resource && !copying ? 'update' : 'create');
  const initial = cleanConfig(
    draft?.after ||
      resource?.value ||
      (kind === 'routes'
        ? { name: '', uri: '', methods: ['GET'], status: 1, plugins: {} }
        : kind === 'consumers'
          ? {
              username: `consumer-${crypto.randomUUID().slice(0, 8)}`,
              plugins: {},
            }
          : {
              name: '',
              type: 'roundrobin',
              scheme: 'http',
              nodes: {},
              timeout: { connect: 6, send: 6, read: 6 },
            }),
  );
  if (copying && kind !== 'consumers') initial.name = `${initial.name || resource?.id}-copy`;
  if (copying && kind === 'consumers') {
    initial.username = `consumer-${crypto.randomUUID().slice(0, 8)}`;
    initial.plugins = {};
  }
  const [value, setValue] = useState<JsonObject>(initial);
  const [raw, setRaw] = useState(pretty(initial));
  const [rawError, setRawError] = useState('');
  const [id, setId] = useState(
    draft?.resource_id ||
      (!copying && resource?.id) ||
      (kind === 'consumers' && initial.username) ||
      `${kind === 'routes' ? 'route' : 'upstream'}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const [mode, setMode] = useState('form');
  const [section, setSection] = useState<EditorSection>('match');
  const [target, setTarget] = useState(() => targetOf(initial, action === 'create' && !copying));
  const [bufferErrors, setBufferErrors] = useState<Record<string, string>>({});
  const [showIssues, setShowIssues] = useState(false);
  const [validation, setValidation] = useState<Validation & { signature: string }>();
  const configVersion = useRef('');
  configVersion.current = JSON.stringify([raw, id, bufferErrors]);
  const typeIssues = useMemo(() => formTypeErrors(kind, value), [kind, value]);
  const allowLeave = useRef(false);
  const baseline = useRef(pretty(initial));
  const initialId = useRef(id);
  const dirty =
    raw !== baseline.current || id !== initialId.current || !!Object.keys(bufferErrors).length;
  const readOnly = !!cluster?.read_only || !can('edit');
  const reportBuffer = useCallback(
    (scope: string, error: string) =>
      setBufferErrors((previous) => {
        if ((previous[scope] || '') === error) return previous;
        const next = { ...previous };
        if (error) next[scope] = error;
        else delete next[scope];
        return next;
      }),
    [],
  );
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !allowLeave.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useBeforeUnload((event) => {
    if (dirty && !allowLeave.current) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  const references = (referenceKind: string) => ({
    queryKey: ['resources', clusterId, referenceKind],
    queryFn: () => api<{ items: Resource[] }>(`/clusters/${clusterId}/resources/${referenceKind}`),
    enabled: kind === 'routes',
  });
  const upstreams = useQuery(references('upstreams'));
  const services = useQuery(references('services'));
  const plugins = useQuery({
    queryKey: ['plugins', clusterId],
    queryFn: () => api<string[]>(`/clusters/${clusterId}/plugins`),
    enabled: kind === 'routes',
  });
  const update = (next: JsonObject) => {
    setValue(next);
    setRaw(pretty(next));
    setRawError('');
    setValidation(undefined);
  };
  const catalog = useQuery({
    queryKey: ['plugin-catalog', clusterId],
    queryFn: () => api<PluginDefinition[]>(`/clusters/${clusterId}/plugins/catalog`),
    enabled: !!clusterId,
  });
  const field = (key: string, next: unknown) => update(patchField(value, key, next));
  const previewRaw = pretty(
    maskPluginSecrets(value, catalog.data, kind === 'consumers', t('••••••（凭据已隐藏）')),
  );
  const issues = useMemo(() => {
    const result: ConfigIssue[] = [];
    if (!(kind === 'consumers' ? /^[a-zA-Z0-9_-]{1,256}$/ : /^[a-zA-Z0-9._-]{1,64}$/).test(id))
      result.push({
        path: 'id',
        section: 'match',
        message:
          kind === 'consumers'
            ? t('消费者用户名须为 1–256 位字母、数字、下划线或短横线')
            : t('资源 ID 仅支持 1–64 位字母、数字、点、下划线或短横线'),
      });
    if (kind === 'consumers' && value.username !== id)
      result.push({
        path: 'username',
        section: 'match',
        message: t('JSON 中的 username 必须与当前消费者用户名一致'),
      });
    if (rawError) result.push({ path: 'json', section: 'review', message: rawError });
    for (const [path, error] of Object.entries(bufferErrors))
      result.push({ path, message: error, section: path.split('.')[0] as EditorSection });
    try {
      result.push(...validateConfig(kind, value));
    } catch {
      result.push({
        path: 'json',
        section: 'review',
        message: t('存在类型不正确的字段，请在 JSON 中修正或执行网关校验'),
      });
    }
    return result;
  }, [id, rawError, bufferErrors, kind, value, t]);
  const assertValid = () => {
    setShowIssues(true);
    if (issues.length) {
      if (mode === 'form') setSection(issues[0].section);
      throw new Error(issues[0].message);
    }
    return JSON.parse(raw) as JsonObject;
  };
  const save = useMutation({
    mutationFn: async () => {
      const candidate = assertValid();
      const body = {
        cluster_id: clusterId,
        resource_type: kind,
        resource_id: id,
        action,
        title: String(candidate.name || id).slice(0, 60),
        base_hash: draft?.base_hash || (!copying ? resource?.hash : undefined),
        revision: draft?.revision,
        value: candidate,
      };
      return draft
        ? api<Draft>(`/drafts/${draft.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : post<Draft>('/drafts', body);
    },
    onSuccess: async (result) => {
      allowLeave.current = true;
      await client.invalidateQueries({ queryKey: ['drafts'] });
      client.removeQueries({ queryKey: ['draft', draft?.id] });
      message.success(t('草稿已保存，网关配置尚未变更'));
      go(`/drafts?preview=${result.id}`);
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const validate = useMutation({
    mutationFn: async () => {
      const signature = configVersion.current;
      const result = await post<Validation>(`/clusters/${clusterId}/validate`, {
        resource_type: kind,
        resource_id: id,
        draft_id: draft?.id,
        value: assertValid(),
      });
      return { result, signature };
    },
    onSuccess: ({ result, signature }) => {
      if (signature !== configVersion.current) {
        message.info(t('配置已修改，请重新校验当前版本'));
        return;
      }
      setValidation({ ...result, signature });
      result.ok
        ? message.success(t('目标网关配置校验通过'))
        : message.warning(t('请根据校验结果调整配置'));
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const switchMode = (next: string) => {
    if (Object.keys(bufferErrors).length) {
      setShowIssues(true);
      message.warning(t('请先完成或移除未填写完整的配置项，再切换编辑模式'));
      return;
    }
    if (next === 'form') {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
        const invalidTypes = formTypeErrors(kind, parsed);
        if (invalidTypes.length) {
          message.warning(feedback(invalidTypes[0].message));
          setShowIssues(true);
          return;
        }
        setValue(parsed);
        setTarget(targetOf(parsed, action === 'create'));
        setRawError('');
      } catch {
        setRawError('JSON 格式不正确，请修正后切换到表单');
        return;
      }
    }
    setMode(next);
  };
  const issueSummary = showIssues && issues.length > 0 && (
    <Alert
      type="error"
      showIcon
      title={t('有 {0} 项配置需要调整', issues.length)}
      description={
        <ul className="config-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  if (!rawError) {
                    setMode('form');
                    setSection(issue.section);
                  }
                }}
              >
                {feedback(issue.message)}
              </button>
            </li>
          ))}
        </ul>
      }
    />
  );
  const basic = (
    <Panel
      title={
        <>
          <span className="section-number">01</span>
          {t('基本信息')}
        </>
      }
    >
      <Form layout="vertical" className="form-panel" disabled={readOnly}>
        {kind === 'consumers' ? (
          <Form.Item
            label={t('消费者用户名')}
            required
            extra={t('用于识别调用方，保存后不可更名。支持 1–256 位字母、数字、下划线和短横线。')}
          >
            <Input
              aria-label={t('消费者用户名')}
              value={id}
              maxLength={256}
              disabled={readOnly || action !== 'create' || !!draft}
              onChange={(event) => {
                setId(event.target.value);
                field('username', event.target.value);
              }}
              placeholder={t('例如：health-check-client')}
            />
          </Form.Item>
        ) : (
          <div className="form-two">
            <Form.Item label={t('名称')}>
              <Input
                aria-label={t('资源名称')}
                value={value.name}
                placeholder={kind === 'routes' ? t('例如：order-api') : t('例如：orders-service')}
                maxLength={100}
                onChange={(e) => field('name', e.target.value)}
              />
            </Form.Item>
            <Form.Item label={t('资源 ID')} required extra={t('保存后不可修改，用于配置引用。')}>
              <Input
                aria-label={t('资源 ID')}
                className="mono"
                value={id}
                disabled={action !== 'create' || !!draft}
                onChange={(e) => setId(e.target.value)}
              />
            </Form.Item>
          </div>
        )}
        <Form.Item label={t('说明')}>
          <Input.TextArea
            aria-label={t('资源说明')}
            value={value.desc}
            rows={2}
            placeholder={t('描述配置用途，方便团队理解')}
            maxLength={256}
            showCount
            onChange={(e) => field('desc', e.target.value)}
          />
        </Form.Item>
        <Form.Item
          label={t('标签')}
          extra={t('例如 team=platform、version=v2；可用于列表搜索和配置归类。')}
        >
          <KeyValueFields
            label={t('标签')}
            value={value.labels || {}}
            onChange={(next) => field('labels', Object.keys(next).length ? next : undefined)}
            scope="match.labels"
            readOnly={readOnly}
            keyPlaceholder="team / version"
          />
        </Form.Item>
        {kind === 'routes' && (
          <>
            <ToggleSetting
              label={t('启用路由')}
              description={t('停用状态也先保存为草稿，发布后生效。')}
              value={value.status !== 0}
              onChange={(next) => field('status', next ? 1 : 0)}
              disabled={readOnly}
            />
            <ToggleSetting
              label="WebSocket"
              description={t('允许 HTTP / HTTPS 上游进行 WebSocket 协议升级。')}
              value={!!value.enable_websocket}
              onChange={(next) => field('enable_websocket', next)}
              disabled={readOnly}
            />
          </>
        )}
      </Form>
    </Panel>
  );
  const targetPanel = (
    <>
      <Panel title={t('转发目标')}>
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <Form.Item
            label={t('绑定服务')}
            extra={t('可继承已有服务的上游和插件；路由自身配置具有更高优先级。')}
          >
            <Select
              aria-label={t('绑定服务')}
              showSearch
              optionFilterProp="label"
              allowClear
              value={value.service_id === undefined ? undefined : String(value.service_id)}
              loading={services.isLoading}
              placeholder={t('不绑定服务')}
              options={services.data?.items.map((s) => ({
                value: s.id,
                label: `${s.value.name || s.id} · ${s.id}`,
              }))}
              onChange={(next) => {
                field('service_id', next);
                if (next && !value.upstream && !value.upstream_id) setTarget('service');
                if (!next && target === 'service') setTarget('reference');
              }}
            />
          </Form.Item>
          {services.error && (
            <RequestError error={services.error} retry={() => services.refetch()} />
          )}
          <Form.Item label={t('上游来源')}>
            <Select
              aria-label={t('上游来源')}
              value={target}
              options={[
                { value: 'reference', label: t('引用独立上游') },
                { value: 'inline', label: t('内联上游 · 在路由内配置') },
                { value: 'service', label: t('继承绑定服务'), disabled: !value.service_id },
                { value: 'none', label: t('由插件直接响应') },
              ]}
              onChange={(next) => {
                setTarget(next);
                const config = { ...value };
                delete config.upstream_id;
                delete config.upstream;
                if (next === 'inline')
                  config.upstream = {
                    type: 'roundrobin',
                    scheme: 'http',
                    nodes: {},
                    timeout: { connect: 6, send: 6, read: 6 },
                  };
                if (next === 'none') delete config.service_id;
                update(config);
              }}
            />
          </Form.Item>
          {target === 'reference' && (
            <Form.Item
              label={t('选择上游')}
              extra={t('若上游仍在草稿中，可在同一个发布变更中一起提交。')}
            >
              <Select
                aria-label={t('选择上游')}
                showSearch
                optionFilterProp="label"
                allowClear
                loading={upstreams.isLoading}
                value={value.upstream_id === undefined ? undefined : String(value.upstream_id)}
                onChange={(next) => field('upstream_id', next)}
                placeholder={t('选择已发布上游')}
                options={upstreams.data?.items.map((u) => ({
                  value: u.id,
                  label: `${u.value.name || u.id} · ${u.id}`,
                }))}
              />
            </Form.Item>
          )}
          {upstreams.error && (
            <RequestError error={upstreams.error} retry={() => upstreams.refetch()} />
          )}
          {target === 'service' && (
            <Alert type="info" showIcon title={t('请求会继承绑定服务的上游配置。')} />
          )}
          {target === 'none' && (
            <Alert
              type="info"
              showIcon
              title={t(
                '适用于 redirect、mocking、serverless 等直接返回响应的插件；没有响应插件时请求可能返回 503。',
              )}
            />
          )}
        </Form>
      </Panel>
      {target === 'inline' && value.upstream && (
        <UpstreamFields
          value={value.upstream}
          onChange={(next) => field('upstream', next)}
          readOnly={readOnly}
        />
      )}
    </>
  );
  const pluginPanel = (
    <>
      <SharedPluginReference
        value={value}
        readOnly={readOnly}
        onChange={(id) => field('plugin_config_id', id)}
      />
      <Panel>
        <div className="plugin-section">
          <PluginManager
            value={value.plugins || {}}
            onChange={(next) => field('plugins', next)}
            readOnly={readOnly}
            resourceId={!copying ? resource?.id : undefined}
            draftId={draft?.id}
          />
          <p className="form-hint">
            {t(
              '请求处理页与这里同步编辑 proxy-rewrite / redirect。实际插件执行顺序由 APISIX 阶段和优先级决定。',
            )}
          </p>
        </div>
      </Panel>
    </>
  );
  const review = (
    <>
      <Panel
        title={t('配置检查')}
        extra={
          <Button
            icon={<SafetyOutlined aria-hidden="true" />}
            loading={validate.isPending}
            onClick={() => validate.mutate()}
          >
            {t('校验当前配置')}
          </Button>
        }
      >
        <div className="form-panel">
          <p className="review-description">
            {t(
              '检查表单完整性、目标网关 Schema 与已有资源引用。校验不会保存草稿或写入网关，发布时还会重新检查版本与依赖。',
            )}
          </p>
          <Descriptions
            column={{ xs: 1, sm: 2 }}
            size="small"
            items={
              kind === 'routes'
                ? [
                    { key: 'name', label: t('路由'), children: String(value.name || id) },
                    {
                      key: 'status',
                      label: t('状态'),
                      children: value.status === 0 ? t('停用') : t('启用'),
                    },
                    {
                      key: 'uri',
                      label: t('匹配路径'),
                      children: matchValues(value, 'uri', 'uris').join(' / ') || t('未配置'),
                    },
                    {
                      key: 'method',
                      label: t('HTTP 方法'),
                      children: Array.isArray(value.methods)
                        ? value.methods.join(', ')
                        : t('全部方法'),
                    },
                    {
                      key: 'host',
                      label: t('域名'),
                      children: matchValues(value, 'host', 'hosts').join(', ') || t('不限制'),
                    },
                    {
                      key: 'upstream',
                      label: t('上游'),
                      children:
                        (value.upstream_id ? String(value.upstream_id) : '') ||
                        (value.upstream
                          ? t('内联上游')
                          : value.service_id
                            ? t('服务 {0}', value.service_id)
                            : t('由插件响应')),
                    },
                    {
                      key: 'plugin',
                      label: t('插件'),
                      span: 2,
                      children: Object.keys(value.plugins || {}).join('、') || t('未配置'),
                    },
                  ]
                : kind === 'consumers'
                  ? [
                      {
                        key: 'username',
                        label: t('消费者'),
                        children: String(value.username || id),
                      },
                      {
                        key: 'plugins',
                        label: t('认证与策略'),
                        children: Object.keys(value.plugins || {}).join('、') || t('未配置'),
                      },
                    ]
                  : [
                      { key: 'name', label: t('上游'), children: String(value.name || id) },
                      {
                        key: 'type',
                        label: t('负载均衡'),
                        children: String(value.type || 'roundrobin'),
                      },
                      { key: 'scheme', label: t('协议'), children: String(value.scheme || 'http') },
                      {
                        key: 'nodes',
                        label: t('节点来源'),
                        children: String(value.discovery_type || t('静态节点')),
                      },
                    ]
            }
          />
        </div>
        {validation?.signature === configVersion.current && <Checks checks={validation.checks} />}
      </Panel>
      <Panel title={t('完整配置')} className="preview-panel">
        <ConfigPreview value={previewRaw} />
      </Panel>
    </>
  );
  const routeTabs = [
    {
      key: 'match',
      label: (
        <span>
          <AimOutlined aria-hidden="true" />
          {t('基础与匹配')}
        </span>
      ),
      children: (
        <>
          {basic}
          <RouteMatchFields value={value} onChange={update} readOnly={readOnly} />
        </>
      ),
    },
    {
      key: 'upstream',
      label: (
        <span>
          <ApartmentOutlined aria-hidden="true" />
          {t('上游服务')}
        </span>
      ),
      children: targetPanel,
    },
    {
      key: 'traffic',
      label: (
        <span>
          <SwapOutlined aria-hidden="true" />
          {t('请求处理')}
        </span>
      ),
      children: (
        <TrafficFields
          value={value}
          onChange={update}
          readOnly={readOnly}
          available={plugins.data}
        />
      ),
    },
    {
      key: 'plugins',
      label: (
        <span>
          <BlockOutlined aria-hidden="true" />
          {t('插件配置')}
        </span>
      ),
      children: pluginPanel,
    },
    {
      key: 'review',
      label: (
        <span>
          <SafetyOutlined aria-hidden="true" />
          {t('检查与预览')}
        </span>
      ),
      children: review,
    },
  ];
  return (
    <BufferContext.Provider value={reportBuffer}>
      <button className="back-link" onClick={() => go(draft ? '/drafts' : `/${kind}`)}>
        <ArrowLeftOutlined aria-hidden="true" />{' '}
        {t('返回{0}', draft ? t('草稿箱') : t('{0}列表', t(kindNames[kind])))}
      </button>
      <PageTitle
        title={t((action === 'create' ? '新建' : readOnly ? '查看' : '编辑') + kindNames[kind])}
        description={t(
          '{0} · 保存草稿，审查差异后发布。',
          value.name ||
            value.username ||
            (kind === 'upstreams'
              ? t('配置上游节点与负载均衡')
              : t('配置路由匹配、转发目标与插件策略')),
        )}
        extra={
          <>
            <Tag color={readOnly ? 'default' : dirty ? 'gold' : 'blue'}>
              {readOnly
                ? t('只读模式')
                : dirty
                  ? t('有未保存修改')
                  : draft
                    ? t('已保存草稿')
                    : t('配置编辑')}
            </Tag>
            <Button
              type="primary"
              icon={<SaveOutlined aria-hidden="true" />}
              loading={save.isPending}
              disabled={readOnly}
              onClick={() => save.mutate()}
            >
              {t('保存草稿')}
            </Button>
          </>
        }
      />
      {issueSummary}
      <div className="editor-layout advanced-editor-layout">
        <div className="editor-main">
          <div className="editor-mode">
            <Space>
              <FileTextOutlined aria-hidden="true" />
              <strong>{t('{0}配置', t(kindNames[kind]))}</strong>
              <span className="muted">{cluster?.name}</span>
            </Space>
            <Segmented
              value={mode}
              onChange={(next) => switchMode(String(next))}
              options={[
                { label: t('可视化表单'), value: 'form' },
                { label: t('JSON 编辑'), value: 'json' },
              ]}
            />
          </div>
          {mode === 'json' ? (
            <Panel>
              <Suspense fallback={<Loading />}>
                <CodeEditor
                  value={raw}
                  onChange={(text) => {
                    setRaw(text);
                    setValidation(undefined);
                    try {
                      const parsed = JSON.parse(text);
                      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
                        throw new Error();
                      setValue(parsed);
                      setRawError('');
                    } catch {
                      setRawError('配置必须是有效的 JSON 对象');
                    }
                  }}
                  readOnly={readOnly}
                  height={700}
                />
              </Suspense>
              {rawError && <Alert type="error" showIcon title={feedback(rawError)} />}
            </Panel>
          ) : typeIssues.length ? (
            <Alert
              type="error"
              showIcon
              title={t('配置字段类型不正确')}
              description={feedback(typeIssues[0].message)}
              action={<Button onClick={() => setMode('json')}>{t('在 JSON 中修正')}</Button>}
            />
          ) : kind === 'routes' ? (
            <Tabs
              className="route-editor-tabs"
              activeKey={section}
              onChange={(key) => setSection(key as EditorSection)}
              items={routeTabs.map((tab) => ({ ...tab, forceRender: true }))}
            />
          ) : (
            <>
              {basic}
              {kind === 'consumers' ? (
                <ConsumerFields
                  value={value}
                  onChange={update}
                  readOnly={readOnly}
                  resourceId={resource?.id}
                  draftId={draft?.id}
                />
              ) : (
                <UpstreamFields value={value} onChange={update} readOnly={readOnly} />
              )}
              {review}
            </>
          )}
        </div>
        <aside className="editor-aside">
          <Panel
            title={
              <Space>
                <CodeOutlined aria-hidden="true" />
                {t('配置预览')}
              </Space>
            }
            extra={<Tag>{t(kindNames[kind])}</Tag>}
            className="preview-panel"
          >
            <ConfigPreview value={previewRaw} />
            <div className="preview-bottom">
              <CheckCircleOutlined aria-hidden="true" />
              <span>{t('表单与 JSON 实时同步')}</span>
            </div>
          </Panel>
          <Panel title={t('保存与发布')}>
            <div className="editor-guidance">
              <div>
                <span>01</span>
                <p>{t('完成配置，检查字段与资源引用')}</p>
              </div>
              <div>
                <span>02</span>
                <p>{t('保存草稿，核对变更差异')}</p>
              </div>
              <div>
                <span>03</span>
                <p>{t('发布前校验与冲突检查')}</p>
              </div>
              <div>
                <span>04</span>
                <p>{t('发布后回读确认，支持回退')}</p>
              </div>
              <Button
                block
                icon={<SafetyOutlined aria-hidden="true" />}
                loading={validate.isPending}
                onClick={() => {
                  setSection('review');
                  validate.mutate();
                }}
              >
                {t('校验当前配置')}
              </Button>
            </div>
          </Panel>
        </aside>
      </div>
      <div className="editor-bottom-bar">
        <span>
          {readOnly
            ? t(cluster?.read_only ? '当前集群为只读模式' : '当前账号仅可查看此配置')
            : dirty
              ? t('当前修改尚未保存')
              : t('网关配置在发布前保持当前版本')}
        </span>
        <Space>
          <Button onClick={() => go(draft ? '/drafts' : `/${kind}`)}>{t('取消')}</Button>
          <Button
            type="primary"
            icon={<SaveOutlined aria-hidden="true" />}
            loading={save.isPending}
            disabled={readOnly}
            onClick={() => save.mutate()}
          >
            {t('保存草稿')}
          </Button>
        </Space>
      </div>
      <Modal
        footer={languageFooter}
        title={t('保留当前编辑？')}
        open={blocker.state === 'blocked'}
        onCancel={() => blocker.state === 'blocked' && blocker.reset()}
        onOk={() => {
          allowLeave.current = true;
          if (blocker.state === 'blocked') blocker.proceed();
        }}
        okText={t('放弃修改并离开')}
        cancelText={t('继续编辑')}
        okButtonProps={{ danger: true }}
      >
        <p>{t('当前页面有未保存的修改，离开后这些修改将丢失。')}</p>
      </Modal>
    </BufferContext.Provider>
  );
}

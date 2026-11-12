import { messageText } from '../i18n/Message';
import { languageFooter } from './LanguageSwitch';
import { useFeedback } from '../i18n/feedback';
import { useLocale, useTranslate } from '../i18n';
import { lazy, Suspense, useEffect, useCallback, useMemo, useState, useRef } from 'react';
import {
  App,
  Alert,
  Button,
  Collapse,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
} from 'antd';
import {
  BlockOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../api';
import { useConsole } from '../context';
import { pretty, type JsonObject } from '../types';
import { RequestError } from './Common';
import { SchemaFields } from '../editor/SchemaFields';
import { BufferContext, JsonField } from '../editor/Fields';
import { patchField } from '../config';
import { useSearchParams } from 'react-router-dom';
import {
  matchesPlugin,
  officialUrl,
  pluginDetail,
  pluginTitle,
  hubGroups,
  extensionCategory,
} from '../pluginHub';
import { pluginGuide, nonRouteSettings, pluginSetup } from '../editor/pluginGuide';
import { PluginIcon } from './PluginIcon';
import {
  authenticationInfo,
  consumerPolicyHints,
  credentialIssues,
  KEEP_SECRET,
  type PluginDefinition,
} from '../plugins';

const CodeEditor = lazy(() => import('./CodeEditor'));
const routeDefaults: Record<string, JsonObject> = {
  'limit-req': {
    rate: 100,
    burst: 50,
    key_type: 'var',
    key: 'remote_addr',
    rejected_code: 429,
  },
  'limit-count': {
    count: 1000,
    time_window: 60,
    key_type: 'var',
    key: 'remote_addr',
    policy: 'local',
    rejected_code: 429,
  },
  'limit-conn': {
    conn: 100,
    burst: 20,
    default_conn_delay: 0.1,
    key: 'remote_addr',
    key_type: 'var',
    rejected_code: 429,
  },
  cors: {
    allow_origins: '*',
    allow_methods: 'GET,POST,PUT,DELETE,OPTIONS',
    allow_headers: '*',
    max_age: 3600,
  },
  'ip-restriction': { whitelist: ['127.0.0.1'] },
  'request-id': { header_name: 'X-Request-Id', include_in_response: true },
};
const fieldNames: Record<string, string> = {
  rate: '请求速率（次 / 秒）',
  burst: '突发容量',
  key_type: '维度类型',
  rejected_code: '拒绝响应码',
  rejected_msg: '拒绝提示',
  nodelay: '不延迟突发请求',
  count: '窗口内请求次数',
  time_window: '时间窗口（秒）',
  policy: '计数策略',
  conn: '并发上限',
  default_conn_delay: '默认延迟（秒）',
  allow_origins: '允许来源',
  allow_methods: '允许方法',
  allow_headers: '允许请求头',
  expose_headers: '暴露响应头',
  allow_credential: '允许携带凭据',
  max_age: '预检缓存（秒）',
  uri: '转发路径',
  host: '转发 Host',
  method: '转发方法',
  status_code: '响应状态码',
  body: '响应正文',
  header_name: '请求头名称',
  include_in_response: '包含在响应中',
  hide_credentials: '隐藏认证凭据',
};

export function PluginManager({
  value,
  onChange,
  readOnly = false,
  resourceId,
  draftId,
  scope = 'route',
  resourceType,
}: {
  value: JsonObject;
  onChange: (plugins: JsonObject) => void;
  readOnly?: boolean;
  resourceId?: string;
  draftId?: string;
  scope?: 'route' | 'consumer';
  resourceType?: string;
}) {
  const feedback = useFeedback();
  const t = useTranslate();
  const locale = useLocale();
  const shared = !!resourceType;
  const consumer = scope === 'consumer';
  const [params] = useSearchParams();
  const initialOpened = useRef(false);
  const { clusterId } = useConsole();
  const { modal } = App.useApp();
  const [validating, setValidating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [category, setCategory] = useState('credentials');
  const [editing, setEditing] = useState('');
  const [fieldSearch, setFieldSearch] = useState('');
  const [draft, setDraft] = useState<JsonObject>({});
  const [raw, setRaw] = useState('{}');
  const [mode, setMode] = useState('form');
  const [errors, setErrors] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const reportField = useCallback(
    (scope: string, error: string) =>
      setFieldErrors((previous) => {
        if ((previous[scope] || '') === error) return previous;
        const next = { ...previous };
        if (error) next[scope] = error;
        else delete next[scope];
        return next;
      }),
    [],
  );
  const plugins = useQuery({
    queryKey: ['plugin-catalog', clusterId],
    queryFn: () => api<PluginDefinition[]>(`/clusters/${clusterId}/plugins/catalog`),
    enabled: !!clusterId,
  });
  const schema = useQuery({
    queryKey: ['plugin-schema', clusterId, editing, scope],
    queryFn: () =>
      api<JsonObject>(`/clusters/${clusterId}/plugins/${editing}/schema?scope=${scope}`),
    enabled: !!editing && !!clusterId,
  });
  const definition = plugins.data?.find((item) => item.name === editing);
  const detail = pluginDetail(editing);
  const guide = pluginGuide(editing, locale);
  const isCredential = (name: string) =>
    plugins.data?.some((item) => item.name === name && item.consumer_source !== 'none');
  const descriptionOf = (name: string) =>
    (consumer ? authenticationInfo[name]?.consumer : authenticationInfo[name]?.route) ||
    consumerPolicyHints[name] ||
    pluginDetail(name).description;
  const formSchema = useMemo(() => {
    const result = structuredClone(schema.data || {});
    const helpScope =
      consumer && definition?.consumer_source === 'dedicated' ? 'consumer' : 'route';
    result['x-field-help'] = guide?.fields[helpScope];
    const retained: string[] = [];
    const visit = (item: any, path: string) => {
      if (item === KEEP_SECRET) retained.push(path);
      else if (item && typeof item === 'object')
        for (const [key, child] of Object.entries(item))
          visit(child, path ? `${path}.${key}` : key);
    };
    visit(value[editing], '');
    result['x-retained-fields'] = retained;
    result.encrypt_fields = [
      ...new Set([
        ...(result.encrypt_fields || []),
        ...retained,
        ...(consumer && isCredential(editing) && result.properties?.key ? ['key'] : []),
      ]),
    ];
    if (consumer && editing === 'jwe-decrypt' && result.properties?.secret)
      result.properties.secret = {
        ...result.properties.secret,
        'x-secret-length': 32,
        'x-base64': draft.is_base64_encoded,
      };
    if (consumer && editing === 'jwt-auth') {
      result.required = [
        ...new Set([
          ...(result.required || []),
          String(draft.algorithm || 'HS256').startsWith('HS') ? 'secret' : 'public_key',
        ]),
      ];
    }
    return result;
  }, [schema.data, editing, consumer, draft, value, plugins.data, definition, guide, locale]);
  const recommended = useMemo(
    () =>
      (plugins.data || [])
        .filter(
          (item) =>
            item.scope !== 'global' &&
            !nonRouteSettings[item.name] &&
            (!consumer ||
              (item.consumer_configurable &&
                (resourceType !== 'credentials' || item.consumer_source !== 'none') &&
                (search || (category === 'credentials') === (item.consumer_source !== 'none')))),
        )
        .map((item) => item.name)
        .filter((name) => !value[name] && matchesPlugin(pluginDetail(name), search))
        .filter((name) => consumer || !groupFilter || pluginDetail(name).category === groupFilter)
        .sort(
          (a, b) =>
            Number(pluginTitle(b) !== b) - Number(pluginTitle(a) !== a) || a.localeCompare(b),
        ),
    [plugins.data, value, search, consumer, category, groupFilter, resourceType],
  );
  const open = (name: string) => {
    const next = structuredClone(value[name] || (!consumer && routeDefaults[name]) || {});
    setDraft(next);
    setRaw(pretty(next));
    setErrors([]);
    setFieldErrors({});
    setMode('form');
    setFieldSearch('');
    setEditing(name);
    setAdding(false);
  };
  useEffect(() => {
    const requested = params.get('plugin');
    if (
      consumer &&
      !initialOpened.current &&
      requested &&
      plugins.data?.some((item) => item.name === requested && item.consumer_configurable)
    ) {
      initialOpened.current = true;
      open(requested);
    }
  }, [plugins.data, consumer]);
  const save = async () => {
    setValidating(true);
    try {
      if (Object.keys(fieldErrors).length) {
        setErrors(['请先修正表单中未完成的 JSON 或键值配置']);
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('插件配置必须为 JSON 对象');
      if (consumer) {
        const issues = credentialIssues(editing, parsed);
        if (issues.length) {
          setErrors(issues);
          return;
        }
      }
      await post(`/clusters/${clusterId}/plugins/${editing}/validate`, {
        value: parsed,
        resource_id: resourceId,
        draft_id: draftId,
        resource_type: resourceType || (consumer ? 'consumers' : 'routes'),
      });
      onChange({ ...value, [editing]: parsed });
      setEditing('');
      setErrors([]);
    } catch (err) {
      setErrors([
        err instanceof SyntaxError ? '配置必须是有效的 JSON 对象' : (err as Error).message,
      ]);
    } finally {
      setValidating(false);
    }
  };
  return (
    <>
      <div className="plugin-manager-heading">
        <div>
          <h3>{shared ? t('插件配置') : consumer ? t('认证方式与访问策略') : t('路由插件')}</h3>
          <p>
            {shared
              ? t('插件设置随当前资源一起发布。')
              : consumer
                ? t('凭据与策略独立配置，支持同一消费者使用多种认证方式。')
                : t('编辑此路由的插件，保存路由时一起发布。')}
          </p>
        </div>
        <Button
          icon={<PlusOutlined aria-hidden="true" />}
          onClick={() => setAdding(true)}
          disabled={readOnly}
        >
          {t('添加插件')}
        </Button>
      </div>
      {!Object.keys(value).length ? (
        <div className="plugin-empty">
          <BlockOutlined aria-hidden="true" />
          <strong>{consumer ? t('为消费者添加第一种认证方式') : t('为请求添加所需的能力')}</strong>
          <p>
            {consumer
              ? t('API Key、Basic、JWT、HMAC、LDAP…由当前网关决定可用能力。')
              : t('认证、限流、改写和可观测，按需组合。')}
          </p>
          <Button onClick={() => setAdding(true)} disabled={readOnly}>
            {t('选择插件')}
          </Button>
        </div>
      ) : (
        <div className="attached-plugins">
          {Object.entries(value).map(([name, config]) => (
            <div className="attached-plugin" key={name}>
              <PluginIcon name={name} />
              <div className="attached-plugin-info">
                <strong>
                  {t(pluginTitle(name))}
                  <code>{name}</code>
                </strong>
                <p>{t(descriptionOf(name))}</p>
              </div>
              {consumer && isCredential(name) ? (
                <Tag color="blue">{t('认证凭据')}</Tag>
              ) : (
                <Switch
                  size="small"
                  checked={!config?._meta?.disable}
                  aria-label={t('启用 {0}', name)}
                  disabled={readOnly}
                  onChange={(enabled) =>
                    onChange({
                      ...value,
                      [name]: { ...config, _meta: { ...(config?._meta || {}), disable: !enabled } },
                    })
                  }
                />
              )}
              <Button
                icon={<EditOutlined aria-hidden="true" />}
                type="text"
                aria-label={t('编辑插件 {0}', name)}
                onClick={() => open(name)}
              />
              <Button
                icon={<DeleteOutlined aria-hidden="true" />}
                type="text"
                danger
                aria-label={t('移除插件 {0}', name)}
                disabled={readOnly}
                onClick={() =>
                  modal.confirm({
                    footer: languageFooter,
                    title: messageText('从当前配置中移除 {0}？', name),
                    okText: messageText('移除'),
                    cancelText: messageText('取消'),
                    onOk: () => {
                      const next = { ...value };
                      delete next[name];
                      onChange(next);
                    },
                  })
                }
              />
            </div>
          ))}
        </div>
      )}
      <div className="page-footnote">
        {t(
          '插件实际执行顺序由阶段和优先级决定。共享服务、消费者及全局规则中的插件请在发布前一并核对。',
        )}
      </div>
      <Modal
        footer={languageFooter(null)}
        title={
          shared ? t('添加插件') : consumer ? t('为消费者添加认证或策略') : t('为路由添加插件')
        }
        open={adding}
        focusTriggerAfterClose={!editing}
        onCancel={() => setAdding(false)}
        width={780}
      >
        {consumer && (
          <Segmented
            className="consumer-plugin-categories"
            value={category}
            onChange={(next) => setCategory(String(next))}
            options={[
              { label: t('认证凭据'), value: 'credentials' },
              { label: t('消费者策略'), value: 'policies' },
            ]}
          />
        )}
        <div className="plugin-picker-tools">
          <Input
            prefix={<SearchOutlined aria-hidden="true" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('搜索插件名称或用途')}
            allowClear
          />
          {!consumer && (
            <Select
              aria-label={t('筛选插件分类')}
              value={groupFilter}
              onChange={setGroupFilter}
              options={['', ...hubGroups.map((g) => g.name), extensionCategory].map((g) => ({
                value: g,
                label: t(g || '全部分类'),
              }))}
            />
          )}
        </div>
        {plugins.isLoading ? (
          <Spin />
        ) : plugins.isError ? (
          <RequestError error={plugins.error} retry={() => plugins.refetch()} />
        ) : (
          <div className="plugin-picker">
            {recommended.map((name) => (
              <button key={name} onClick={() => open(name)}>
                <div>
                  <span className="picker-plugin-title">
                    <PluginIcon name={name} />
                    <strong>{t(pluginTitle(name))}</strong>
                  </span>
                  <Tag>{t(pluginDetail(name).category)}</Tag>
                </div>
                <code>{name}</code>
                <p>{t(descriptionOf(name))}</p>
              </button>
            ))}
            {!recommended.length && <Empty description={t('没有匹配的可添加插件')} />}
          </div>
        )}
      </Modal>
      <Modal
        footer={languageFooter}
        title={
          <Space>
            <PluginIcon name={editing} />
            {t(pluginTitle(editing))}
            <Tag>{editing}</Tag>
          </Space>
        }
        open={!!editing}
        onCancel={() => setEditing('')}
        onOk={save}
        confirmLoading={validating}
        okText={shared ? t('应用到配置') : consumer ? t('应用到消费者') : t('应用到路由')}
        cancelText={t('取消')}
        width={920}
        className="plugin-config-dialog"
        okButtonProps={{ disabled: readOnly || schema.isLoading || schema.isError }}
        destroyOnHidden
      >
        <section className="plugin-config-overview">
          <div>
            <span className="plugin-config-category">{t(detail.category)}</span>
            <p>{t(detail.description)}</p>
            {pluginSetup[editing] && <p className="form-hint">{t(pluginSetup[editing])}</p>}
          </div>
          {detail.docs && (
            <a href={officialUrl(detail.docs, locale)} target="_blank" rel="noreferrer">
              {t('官方插件文档')} <ExportOutlined />
            </a>
          )}
        </section>
        {(authenticationInfo[editing] ||
          (definition?.consumer_source !== undefined && definition.consumer_source !== 'none') ||
          consumerPolicyHints[editing]) && (
          <Alert
            className="key-auth-guidance"
            type="info"
            showIcon
            title={consumer ? t('在此设置消费者凭据或策略') : t('此插件与消费者配置关联')}
            description={
              <div>
                <p>{t(descriptionOf(editing))}</p>
                {!consumer && (
                  <Space wrap>
                    <Button
                      href={`/consumers?cluster=${encodeURIComponent(clusterId)}${isCredential(editing) ? `&plugin=${encodeURIComponent(editing)}` : ''}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('管理关联消费者 ↗')}
                    </Button>
                    {isCredential(editing) && (
                      <Button
                        href={`/consumers/new?cluster=${encodeURIComponent(clusterId)}&plugin=${encodeURIComponent(editing)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('创建认证凭据 ↗')}
                      </Button>
                    )}
                  </Space>
                )}
                {authenticationInfo[editing]?.request && (
                  <p className="auth-request-example">
                    <code>{t(authenticationInfo[editing].request)}</code>
                  </p>
                )}
                <p className="form-hint">
                  {consumer
                    ? t('保存消费者后，请在路由中启用对应认证插件。')
                    : schema.data?.properties?.anonymous_consumer
                      ? t(
                          '消费者管理在新标签页打开。匿名消费者会允许未认证请求通过，需要强制认证时请留空。',
                        )
                      : t('消费者管理在新标签页打开，保留当前路由编辑。')}
                </p>
              </div>
            }
          />
        )}
        <div className="plugin-modal-tools">
          {mode === 'form' && (
            <Input
              allowClear
              prefix={<SearchOutlined />}
              className="plugin-field-search"
              aria-label={t('查找配置项')}
              placeholder={t('查找配置项')}
              value={fieldSearch}
              disabled={Object.keys(fieldErrors).length > 0}
              onChange={(event) => setFieldSearch(event.target.value)}
            />
          )}
          <Segmented
            value={mode}
            onChange={(v) => {
              if (Object.keys(fieldErrors).length) {
                setErrors(['请先修正表单中未完成的 JSON 或键值配置']);
                return;
              }
              if (v === 'form') {
                try {
                  const parsed = JSON.parse(raw);
                  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
                    throw new Error();
                  setDraft(parsed);
                  setErrors([]);
                } catch {
                  setErrors(['请先修正 JSON，再切换到表单']);
                  return;
                }
              }
              setMode(String(v));
            }}
            options={[
              { label: t('配置表单'), value: 'form' },
              { label: 'JSON', value: 'json' },
            ]}
          />
        </div>
        {schema.isLoading ? (
          <Spin />
        ) : schema.isError ? (
          <RequestError error={schema.error} retry={() => schema.refetch()} />
        ) : mode === 'form' ? (
          <BufferContext.Provider value={reportField}>
            <Form layout="vertical" disabled={readOnly}>
              <SchemaFields
                labels={
                  consumer
                    ? {
                        key: t('凭据标识 / 密钥'),
                        username: t('登录用户名'),
                        password: t('登录密码'),
                        secret: t('签名 / 解密密钥'),
                        public_key: t('验签公钥（PEM）'),
                        key_id: t('签名标识'),
                        secret_key: t('签名密钥'),
                        user_dn: t('目录用户 DN'),
                        appid: t('Wolf 应用标识'),
                        server: t('Wolf 服务地址'),
                      }
                    : editing === 'key-auth'
                      ? {
                          ...fieldNames,
                          header: t('密钥请求头名称'),
                          query: t('密钥查询参数名称'),
                          anonymous_consumer: t('匿名消费者（可选）'),
                          realm: t('认证域'),
                        }
                      : ['limit-req', 'limit-count', 'limit-conn'].includes(editing)
                        ? { ...fieldNames, key: '计数维度' }
                        : fieldNames
                }
                readOnly={readOnly}
                filter={fieldSearch}
                schema={formSchema}
                value={draft}
                onChange={(next) => {
                  setDraft(next);
                  setRaw(pretty(next));
                  setErrors([]);
                }}
              />
              {!(consumer && isCredential(editing)) && (
                <Collapse
                  className="plugin-execution-settings"
                  items={[
                    {
                      key: 'execution',
                      label: t('高级执行选项'),
                      children: (
                        <>
                          <Form.Item
                            label={t('执行优先级')}
                            extra={t(
                              '仅覆盖当前插件在所属阶段内的优先级，不改变 APISIX 执行阶段。',
                            )}
                          >
                            <InputNumber
                              aria-label={t('插件执行优先级')}
                              precision={0}
                              value={draft._meta?.priority}
                              onChange={(next) => {
                                const updated = {
                                  ...draft,
                                  _meta: patchField(draft._meta || {}, 'priority', next),
                                };
                                setDraft(updated);
                                setRaw(pretty(updated));
                              }}
                            />
                          </Form.Item>
                          <Form.Item
                            label={t('插件执行条件')}
                            extra={t('符合表达式时才执行。空数组表示不增加执行条件。')}
                          >
                            <JsonField
                              label={t('插件执行条件 JSON')}
                              value={draft._meta?.filter || []}
                              onChange={(next) => {
                                const meta = patchField(
                                  draft._meta || {},
                                  'filter',
                                  next.length ? next : undefined,
                                );
                                const updated = { ...draft, _meta: meta };
                                setDraft(updated);
                                setRaw(pretty(updated));
                              }}
                              scope="plugin.meta.filter"
                              kind="array"
                              readOnly={readOnly}
                            />
                          </Form.Item>
                          {Object.keys(formSchema.properties?._meta?.properties || {}).some(
                            (key) => !['filter', 'priority'].includes(key),
                          ) && (
                            <SchemaFields
                              prefix="_meta"
                              root={formSchema}
                              schema={{
                                properties: Object.fromEntries(
                                  Object.entries(formSchema.properties._meta.properties).filter(
                                    ([key]) => !['filter', 'priority'].includes(key),
                                  ),
                                ),
                              }}
                              value={draft._meta || {}}
                              readOnly={readOnly}
                              onChange={(meta) => {
                                const next = { ...draft, _meta: meta };
                                setDraft(next);
                                setRaw(pretty(next));
                              }}
                            />
                          )}
                        </>
                      ),
                    },
                  ]}
                />
              )}
            </Form>
          </BufferContext.Provider>
        ) : (
          <Suspense fallback={<Spin />}>
            <CodeEditor
              value={raw}
              onChange={(text) => {
                setRaw(text);
                setErrors([]);
              }}
              readOnly={readOnly}
              height={390}
              label={t('插件 JSON 配置')}
            />
          </Suspense>
        )}
        {errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            title={t('配置需要调整')}
            description={errors.map(feedback).join(' · ')}
            style={{ marginTop: 12 }}
          />
        )}
      </Modal>
    </>
  );
}

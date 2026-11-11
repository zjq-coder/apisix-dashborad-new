import { useTranslate } from '../i18n';
import { Alert, Button, Form, Input, Select, Space, Switch, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Panel } from '../components/Common';
import { patchField } from '../config';
import type { JsonObject } from '../types';
import { KeyValueFields, StringListField, ToggleSetting } from './Fields';
import { setRedirectMode, setRewriteMode, structuredHeaders, updatePlugin } from './config';

function RegexPairs({
  value,
  onChange,
  readOnly,
  single,
  prefix,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  single?: boolean;
  prefix: string;
}) {
  const t = useTranslate();
  const pairs = Array.from({ length: Math.ceil(value.length / 2) }, (_, i) => [
    value[i * 2] || '',
    value[i * 2 + 1] || '',
  ]);
  return (
    <div className="field-collection">
      {pairs.map(([pattern, replacement], i) => (
        <div className="regex-pair" key={i}>
          <div className="form-two">
            <Form.Item label={t('匹配正则 {0}', i + 1)} required>
              <Input
                aria-label={t('{0}匹配正则 {1}', prefix, i + 1)}
                className="mono"
                disabled={readOnly}
                value={pattern}
                placeholder="^/api/(.*)"
                onChange={(e) =>
                  onChange(value.map((item, index) => (index === i * 2 ? e.target.value : item)))
                }
              />
            </Form.Item>
            <Form.Item label={t('替换路径 {0}', i + 1)} required>
              <Input
                aria-label={t('{0}替换路径 {1}', prefix, i + 1)}
                className="mono"
                disabled={readOnly}
                value={replacement}
                placeholder="/internal/$1"
                onChange={(e) =>
                  onChange(
                    value.map((item, index) => (index === i * 2 + 1 ? e.target.value : item)),
                  )
                }
              />
            </Form.Item>
          </div>
          {!single && pairs.length > 1 && (
            <Button
              type="text"
              danger
              disabled={readOnly}
              aria-label={t('移除{0}正则 {1}', prefix, i + 1)}
              icon={<DeleteOutlined aria-hidden="true" />}
              onClick={() => onChange(value.filter((_, index) => Math.floor(index / 2) !== i))}
            />
          )}
        </div>
      ))}
      {!single && (
        <Button
          type="dashed"
          icon={<PlusOutlined aria-hidden="true" />}
          disabled={readOnly}
          onClick={() => onChange([...value, '', ''])}
        >
          {t('添加改写规则')}
        </Button>
      )}
      <p className="form-hint">
        {t('使用 $1、$2 引用捕获组。表达式遵循网关 PCRE 语法，最终以目标网关校验为准。')}
      </p>
    </div>
  );
}

export function TrafficFields({
  value,
  onChange,
  readOnly,
  available,
}: {
  value: JsonObject;
  onChange: (next: JsonObject) => void;
  readOnly: boolean;
  available?: string[];
}) {
  const t = useTranslate();
  const rewrite = value.plugins?.['proxy-rewrite'];
  const redirect = value.plugins?.redirect;
  const setRewrite = (next?: JsonObject) => onChange(updatePlugin(value, 'proxy-rewrite', next));
  const setRedirect = (next?: JsonObject) => onChange(updatePlugin(value, 'redirect', next));
  const rewriteField = (key: string, next: unknown) =>
    setRewrite(patchField(rewrite || {}, key, next));
  const redirectField = (key: string, next: unknown) =>
    setRedirect(patchField(redirect || {}, key, next));
  const headers = structuredHeaders(rewrite?.headers);
  const pathMode = rewrite?.uri !== undefined ? 'uri' : rewrite?.regex_uri ? 'regex' : 'keep';
  const redirectMode = redirect?.http_to_https ? 'https' : redirect?.regex_uri ? 'regex' : 'uri';
  return (
    <>
      <div className="info-strip">
        {t('请求处理与插件页编辑同一份配置；目标网关的插件 Schema 会在校验时检查参数兼容性。')}
      </div>
      <Panel
        title={
          <Space>
            {t('请求改写')}
            <Tag>proxy-rewrite</Tag>
          </Space>
        }
      >
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <ToggleSetting
            label={t('配置请求改写')}
            description={t('修改转发给上游的路径、方法、Host 和请求头。关闭会移除此插件。')}
            value={!!rewrite}
            disabled={readOnly || (!rewrite && !available?.includes('proxy-rewrite'))}
            onChange={(enabled) => setRewrite(enabled ? {} : undefined)}
          />
          {!available?.includes('proxy-rewrite') && (
            <p className="form-hint">
              {t('当前集群插件清单尚未包含 proxy-rewrite，请检查插件加载状态。')}
            </p>
          )}
          {rewrite && (
            <div className="setting-body">
              {rewrite._meta?.disable && (
                <Alert
                  type="warning"
                  showIcon
                  title={t('该插件目前已停用，可在插件配置页重新启用。')}
                />
              )}
              <div className="form-two">
                <Form.Item label={t('路径改写方式')}>
                  <Select
                    aria-label={t('路径改写方式')}
                    value={pathMode}
                    options={[
                      { value: 'keep', label: t('保持原路径') },
                      { value: 'uri', label: t('静态路径') },
                      { value: 'regex', label: t('正则改写') },
                    ]}
                    onChange={(next) => setRewrite(setRewriteMode(rewrite, next))}
                  />
                </Form.Item>
                <div className="schema-description">
                  {t('转发协议在「上游服务」中设置，支持 HTTP、HTTPS 和 gRPC。')}
                </div>
              </div>
              {pathMode === 'uri' && (
                <Form.Item label={t('目标转发路径')} required>
                  <Input
                    aria-label={t('目标转发路径')}
                    className="mono"
                    value={rewrite.uri}
                    placeholder="/internal/orders"
                    onChange={(e) => setRewrite({ ...rewrite, uri: e.target.value })}
                  />
                </Form.Item>
              )}
              {pathMode === 'regex' && (
                <RegexPairs
                  value={rewrite.regex_uri}
                  onChange={(next) => rewriteField('regex_uri', next)}
                  readOnly={readOnly}
                  prefix={t('请求改写')}
                />
              )}
              <div className="form-two">
                <Form.Item
                  label={t('改写 Host')}
                  extra={t('Host 请在这里设置，而非放入请求头表格。')}
                >
                  <Input
                    aria-label={t('改写 Host')}
                    value={rewrite.host}
                    placeholder={t('留空保持原值')}
                    onChange={(e) => rewriteField('host', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label={t('改写 HTTP 方法')}>
                  <Select
                    aria-label={t('改写 HTTP 方法')}
                    allowClear
                    value={rewrite.method}
                    placeholder={t('保持原方法')}
                    options={[
                      'GET',
                      'POST',
                      'PUT',
                      'HEAD',
                      'DELETE',
                      'OPTIONS',
                      'PATCH',
                      'TRACE',
                      'MKCOL',
                      'COPY',
                      'MOVE',
                      'PROPFIND',
                      'LOCK',
                      'UNLOCK',
                    ].map((v) => ({ value: v }))}
                    onChange={(next) => rewriteField('method', next)}
                  />
                </Form.Item>
              </div>
              <div className="field-subheading">
                <strong>{t('请求头操作')}</strong>
                <span>{t('按追加、移除、覆盖的顺序执行')}</span>
              </div>
              <Form.Item label={t('设置 / 覆盖请求头')}>
                <KeyValueFields
                  label={t('覆盖请求头')}
                  caseInsensitive
                  scope="traffic.headers.set"
                  value={headers.set || {}}
                  onChange={(next) =>
                    setRewrite({
                      ...rewrite,
                      headers: patchField(
                        headers,
                        'set',
                        Object.keys(next).length ? next : undefined,
                      ),
                    })
                  }
                  readOnly={readOnly}
                  keyPlaceholder="X-Tenant"
                  valuePlaceholder="$arg_tenant"
                />
              </Form.Item>
              <Form.Item label={t('追加请求头')}>
                <KeyValueFields
                  label={t('追加请求头')}
                  caseInsensitive
                  scope="traffic.headers.add"
                  value={headers.add || {}}
                  onChange={(next) =>
                    setRewrite({
                      ...rewrite,
                      headers: patchField(
                        headers,
                        'add',
                        Object.keys(next).length ? next : undefined,
                      ),
                    })
                  }
                  readOnly={readOnly}
                />
              </Form.Item>
              <Form.Item label={t('移除请求头')}>
                <StringListField
                  label={t('移除请求头')}
                  scope="traffic.headers.remove"
                  value={headers.remove || []}
                  onChange={(next) =>
                    setRewrite({
                      ...rewrite,
                      headers: patchField(headers, 'remove', next.length ? next : undefined),
                    })
                  }
                  readOnly={readOnly}
                  placeholder="X-Internal-Token"
                />
              </Form.Item>
            </div>
          )}
        </Form>
      </Panel>
      <Panel
        title={
          <Space>
            {t('客户端重定向')}
            <Tag>redirect</Tag>
          </Space>
        }
      >
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <ToggleSetting
            label={t('配置重定向')}
            description={t('向客户端返回新的访问地址。关闭会移除此插件。')}
            value={!!redirect}
            disabled={readOnly || (!redirect && !available?.includes('redirect'))}
            onChange={(enabled) => setRedirect(enabled ? { uri: '', ret_code: 302 } : undefined)}
          />
          {redirect && (
            <div className="setting-body">
              {redirect._meta?.disable && (
                <Alert
                  type="warning"
                  showIcon
                  title={t('该插件目前已停用，可在插件配置页重新启用。')}
                />
              )}
              <Form.Item label={t('重定向方式')}>
                <Select
                  aria-label={t('重定向方式')}
                  value={redirectMode}
                  options={[
                    { value: 'uri', label: t('指定目标地址') },
                    { value: 'regex', label: t('正则匹配与替换') },
                    { value: 'https', label: t('HTTP 转 HTTPS') },
                  ]}
                  onChange={(next) => setRedirect(setRedirectMode(redirect, next))}
                />
              </Form.Item>
              {redirectMode === 'uri' && (
                <Form.Item label={t('重定向目标')} required>
                  <Input
                    aria-label={t('重定向目标')}
                    value={redirect.uri}
                    className="mono"
                    placeholder="https://example.com/new-path"
                    onChange={(e) => setRedirect({ ...redirect, uri: e.target.value })}
                  />
                </Form.Item>
              )}
              {redirectMode === 'regex' && (
                <RegexPairs
                  value={redirect.regex_uri}
                  onChange={(next) => redirectField('regex_uri', next)}
                  readOnly={readOnly}
                  single
                  prefix={t('重定向')}
                />
              )}
              {redirectMode === 'https' ? (
                <Alert
                  type="info"
                  showIcon
                  title={t(
                    'HTTP 请求使用 301 跳转到 HTTPS，保留原路径及查询参数。HTTPS 请求继续执行后续流程。',
                  )}
                />
              ) : (
                <>
                  <Form.Item label={t('重定向状态码')}>
                    <Select
                      aria-label={t('重定向状态码')}
                      value={redirect.ret_code ?? 302}
                      options={[301, 302, 303, 307, 308].map((code) => ({
                        value: code,
                        label: String(code),
                      }))}
                      onChange={(next) => redirectField('ret_code', next)}
                    />
                  </Form.Item>
                  <div className="form-two">
                    <Form.Item label={t('追加原查询参数')}>
                      <Switch
                        aria-label={t('追加原查询参数')}
                        checked={!!redirect.append_query_string}
                        onChange={(next) => redirectField('append_query_string', next)}
                      />
                    </Form.Item>
                    <Form.Item label={t('对目标 URI 编码')}>
                      <Switch
                        aria-label={t('对目标 URI 编码')}
                        checked={!!redirect.encode_uri}
                        onChange={(next) => redirectField('encode_uri', next)}
                      />
                    </Form.Item>
                  </div>
                </>
              )}
            </div>
          )}
        </Form>
      </Panel>
    </>
  );
}

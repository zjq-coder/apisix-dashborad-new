import { useTranslate } from '../i18n';
import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { JsonObject } from '../types';
import { patchField } from '../config';
import { Panel } from '../components/Common';
import { JsonField, StringListField } from './Fields';
import {
  isCIDR,
  logicalOperators,
  matchValues,
  methods,
  operators,
  setMatchValues,
} from './config';

const sources = [
  { value: 'http_', label: 'HTTP 请求头' },
  { value: 'arg_', label: 'Query 参数' },
  { value: 'post_arg_', label: 'POST 表单' },
  { value: 'cookie_', label: 'Cookie' },
  { value: '', label: 'Nginx 变量' },
];
function sourceFor(name: string) {
  return sources.find((source) => source.value && name.startsWith(source.value))?.value || '';
}

function Condition({
  value,
  onChange,
  scope,
  readOnly,
}: {
  value: any[];
  onChange: (next: any[]) => void;
  scope: string;
  readOnly: boolean;
}) {
  const t = useTranslate();
  const scopeLabel = [t('条件'), scope].filter(Boolean).join(' ');
  const negated = value[1] === '!';
  const op = value[negated ? 2 : 1];
  const operand = value[negated ? 3 : 2];
  const source = sourceFor(value[0]);
  const type = operand === null ? 'null' : Array.isArray(operand) ? 'array' : typeof operand;
  const update = (name = value[0], operator = op, right = operand, reverse = negated) =>
    onChange(reverse ? [name, '!', operator, right] : [name, operator, right]);
  if (
    ![3, 4].includes(value.length) ||
    !operators.includes(op) ||
    !['string', 'number', 'boolean', 'null', 'array'].includes(type)
  )
    return (
      <JsonField
        label={t('{0} 原始条件', scopeLabel)}
        value={value}
        onChange={onChange}
        scope={`match.${scope}`}
        kind="array"
        readOnly={readOnly}
      />
    );
  return (
    <div className="condition-fields">
      <Form.Item label={t('参数位置')}>
        <Select
          aria-label={t('{0} 参数位置', scopeLabel)}
          value={source}
          options={sources.map((item) => ({ ...item, label: t(item.label) }))}
          onChange={(next) => update(next + value[0].slice(source.length))}
        />
      </Form.Item>
      <Form.Item label={t('参数名称')}>
        <Input
          aria-label={t('{0} 参数名称', scopeLabel)}
          value={value[0].slice(source.length)}
          placeholder={source === 'http_' ? 'x-tenant-id' : source ? 'version' : 'remote_addr'}
          onChange={(e) =>
            update(
              source +
                (source === 'http_'
                  ? e.target.value.toLowerCase().replaceAll('-', '_')
                  : e.target.value),
            )
          }
        />
      </Form.Item>
      <Form.Item label={t('运算符')}>
        <Select
          aria-label={t('{0} 运算符', scopeLabel)}
          value={op}
          options={operators.map((operator) => ({
            value: operator,
            label:
              operator === '~~' ? t('正则 ~~') : operator === '~*' ? t('忽略大小写 ~*') : operator,
          }))}
          onChange={(operator) =>
            update(
              value[0],
              operator,
              ['in', 'ipmatch'].includes(operator)
                ? Array.isArray(operand)
                  ? operand
                  : [String(operand ?? '')]
                : ['>', '>=', '<', '<='].includes(operator)
                  ? Number(operand) || 0
                  : operand,
            )
          }
        />
      </Form.Item>
      <Form.Item label={t('取反')}>
        <Switch
          aria-label={t('{0} 取反', scopeLabel)}
          checked={negated}
          onChange={(next) => update(value[0], op, operand, next)}
        />
      </Form.Item>
      <Form.Item label={t('值类型')}>
        <Select
          aria-label={t('{0} 值类型', scopeLabel)}
          value={type}
          options={[
            { value: 'string', label: t('文本') },
            { value: 'number', label: t('数字') },
            { value: 'boolean', label: t('布尔值') },
            { value: 'null', label: t('空值 null') },
            { value: 'array', label: t('数组') },
          ]}
          onChange={(next) =>
            update(
              value[0],
              op,
              next === 'array'
                ? []
                : next === 'number'
                  ? 0
                  : next === 'boolean'
                    ? true
                    : next === 'null'
                      ? null
                      : '',
            )
          }
        />
      </Form.Item>
      <Form.Item className="condition-value" label={t('参数值')}>
        {type === 'array' ? (
          <JsonField
            scope={`match.${scope}.value`}
            label={t('{0} 参数值', scopeLabel)}
            value={operand}
            onChange={(next) => update(value[0], op, next)}
            kind="array"
            readOnly={readOnly}
            rows={2}
          />
        ) : type === 'number' ? (
          <InputNumber
            aria-label={t('{0} 参数值', scopeLabel)}
            value={operand}
            onChange={(next) => update(value[0], op, next)}
            style={{ width: '100%' }}
          />
        ) : type === 'boolean' ? (
          <Select
            aria-label={t('{0} 参数值', scopeLabel)}
            value={operand ? 'true' : 'false'}
            options={[
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' },
            ]}
            onChange={(next) => update(value[0], op, next === 'true')}
          />
        ) : type === 'null' ? (
          <Input value="null" disabled />
        ) : (
          <Input
            aria-label={t('{0} 参数值', scopeLabel)}
            value={operand}
            onChange={(e) => update(value[0], op, e.target.value)}
          />
        )}
      </Form.Item>
    </div>
  );
}

export function ExpressionFields({
  value = [],
  onChange,
  readOnly = false,
  scope = '',
  depth = 0,
}: {
  value?: any;
  onChange: (value: any[]) => void;
  readOnly?: boolean;
  scope?: string;
  depth?: number;
}) {
  const t = useTranslate();
  const scopeLabel = [t('条件'), scope].filter(Boolean).join(' ');
  const group =
    Array.isArray(value) &&
    (value.length === 0 || Array.isArray(value[0]) || logicalOperators.includes(value[0]));
  if (!group || depth > 5)
    return (
      <div>
        <Alert
          type="info"
          showIcon
          title={t('此条件使用原始表达式结构，修改其他字段时会完整保留。')}
        />
        <JsonField
          label={`${scopeLabel} JSON`}
          value={value}
          onChange={onChange}
          kind="array"
          scope={`match.${scope}`}
          readOnly={readOnly}
        />
      </div>
    );
  const explicit = typeof value[0] === 'string';
  const logic = explicit ? value[0] : 'AND';
  const items: any[] = explicit ? value.slice(1) : value;
  const update = (next: any[]) => onChange(explicit ? [logic, ...next] : next);
  return (
    <div className={`expression-group ${depth ? 'expression-nested' : ''}`}>
      <div className="expression-heading">
        <Space wrap>
          <strong>{depth ? t('条件组') : t('匹配逻辑')}</strong>
          <Select
            aria-label={t('{0} 匹配逻辑', scopeLabel)}
            value={logic}
            disabled={readOnly}
            options={[
              { value: 'AND', label: t('全部满足 AND') },
              { value: 'OR', label: t('任一满足 OR') },
              { value: '!AND', label: t('不全部满足 !AND') },
              { value: '!OR', label: t('均不满足 !OR') },
            ]}
            onChange={(next) => onChange([next, ...items])}
          />
        </Space>
        <Tag>
          {items.length} {t('项')}
        </Tag>
      </div>
      {!items.length && (
        <p className="field-empty-hint">{t('未设置附加条件，请求按路径、域名和方法匹配。')}</p>
      )}
      {items.map((item, index) => {
        const childScope = [scope, index + 1].filter(Boolean).join(' ');
        const title = t('条件') + ' ' + childScope;
        const leaf =
          Array.isArray(item) && typeof item[0] === 'string' && !logicalOperators.includes(item[0]);
        return (
          <div className="condition-card" key={index}>
            <div className="condition-title">
              <span>{title}</span>
              <Button
                type="text"
                danger
                disabled={readOnly}
                size="small"
                aria-label={t('删除{0}', title)}
                icon={<DeleteOutlined aria-hidden="true" />}
                onClick={() => update(items.filter((_, i) => i !== index))}
              />
            </div>
            {leaf ? (
              <Condition
                value={item}
                scope={childScope}
                readOnly={readOnly}
                onChange={(next) => update(items.map((old, i) => (i === index ? next : old)))}
              />
            ) : (
              <ExpressionFields
                value={item}
                scope={childScope}
                depth={depth + 1}
                readOnly={readOnly}
                onChange={(next) => update(items.map((old, i) => (i === index ? next : old)))}
              />
            )}
          </div>
        );
      })}
      <Space wrap>
        <Button
          icon={<PlusOutlined aria-hidden="true" />}
          disabled={readOnly}
          onClick={() => update([...items, ['arg_', '==', '']])}
        >
          {t('添加条件')}
        </Button>
        <Button
          type="dashed"
          disabled={readOnly || depth >= 5}
          onClick={() => update([...items, ['OR', ['arg_', '==', ''], ['arg_', '==', '']]])}
        >
          {t('添加条件组')}
        </Button>
      </Space>
      {!depth && (
        <p className="form-hint">
          {t(
            'HTTP 请求头自动转换为 http_ 变量；POST 表单条件适用于 x-www-form-urlencoded。复杂规则仍可切换 JSON 编辑。',
          )}
        </p>
      )}
    </div>
  );
}

export function RouteMatchFields({
  value,
  onChange,
  readOnly,
}: {
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  readOnly: boolean;
}) {
  const t = useTranslate();
  const field = (name: string, next: unknown) => onChange(patchField(value, name, next));
  return (
    <>
      <Panel
        title={
          <>
            <span className="section-number">02</span>
            {t('请求匹配')}
          </>
        }
      >
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <Form.Item
            label={t('匹配路径')}
            required
            extra={t('支持精确路径和通配符；多条路径之间满足任一条即可。')}
          >
            <StringListField
              label={t('匹配路径 URI')}
              required
              value={matchValues(value, 'uri', 'uris')}
              onChange={(entries) => onChange(setMatchValues(value, 'uri', 'uris', entries))}
              scope="match.uris"
              placeholder="/api/orders/*"
              readOnly={readOnly}
              check={(uri) => (uri.startsWith('/') ? '' : '路径需要以 / 开头')}
            />
          </Form.Item>
          <div className="form-two">
            <Form.Item label={t('域名')} extra={t('支持 *.example.com，留空不限制域名。')}>
              <StringListField
                label={t('域名 Host')}
                value={matchValues(value, 'host', 'hosts')}
                onChange={(entries) => onChange(setMatchValues(value, 'host', 'hosts', entries))}
                scope="match.hosts"
                placeholder="api.example.com"
                readOnly={readOnly}
              />
            </Form.Item>
            <Form.Item
              label={t('客户端地址')}
              extra={t('支持 IPv4、IPv6 和 CIDR，留空不限制来源。')}
            >
              <StringListField
                label={t('客户端地址')}
                value={matchValues(value, 'remote_addr', 'remote_addrs')}
                onChange={(entries) =>
                  onChange(setMatchValues(value, 'remote_addr', 'remote_addrs', entries))
                }
                scope="match.remote_addrs"
                placeholder="192.168.1.0/24"
                readOnly={readOnly}
                check={(ip) => (isCIDR(ip) ? '' : '请输入合法的 IP 地址或 CIDR')}
              />
            </Form.Item>
          </div>
          <div className="form-two">
            <Form.Item label={t('HTTP 方法')} extra={t('清空后匹配全部 HTTP 方法。')}>
              <Select
                aria-label={t('HTTP 方法')}
                mode="multiple"
                value={value.methods || []}
                options={methods.map((m) => ({ value: m }))}
                onChange={(next) => field('methods', next.length ? next : undefined)}
              />
            </Form.Item>
            <Form.Item
              label={t('匹配优先级')}
              extra={t('多条规则同时命中时，优先匹配更大的数值。')}
            >
              <InputNumber
                aria-label={t('匹配优先级')}
                value={value.priority ?? 0}
                precision={0}
                style={{ width: '100%' }}
                onChange={(next) => field('priority', next)}
              />
            </Form.Item>
          </div>
        </Form>
      </Panel>
      <Panel
        title={
          <>
            <span className="section-number">03</span>
            {t('高级匹配条件')}
          </>
        }
      >
        <Form layout="vertical" className="form-panel" disabled={readOnly}>
          <ExpressionFields
            value={value.vars || []}
            onChange={(next) => field('vars', next.length ? next : undefined)}
            readOnly={readOnly}
          />
          <Collapse
            ghost
            className="advanced-collapse"
            items={[
              {
                key: 'filter',
                label: t('Lua 自定义匹配函数'),
                children: (
                  <Form.Item
                    label="filter_func"
                    extra={t('接收 vars 与 ctx，返回是否匹配。语法与运行结果需在网关中验证。')}
                  >
                    <Input.TextArea
                      aria-label={t('Lua 匹配函数')}
                      className="mono"
                      value={value.filter_func}
                      rows={5}
                      placeholder="function(vars, ctx) return true end"
                      onChange={(e) => field('filter_func', e.target.value)}
                    />
                  </Form.Item>
                ),
              },
            ]}
          />
        </Form>
      </Panel>
    </>
  );
}

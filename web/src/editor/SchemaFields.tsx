import { useTranslate } from '../i18n';
import { useRef } from 'react';
import { App, Button, Collapse, Form, Input, InputNumber, Select, Space, Tag } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { JsonObject } from '../types';
import { activeSchema, KEEP_SECRET } from '../plugins';
import { JsonField, KeyValueFields } from './Fields';
import { isObject } from './config';
import { distinctTypes, typeMatches, alternativeGroups } from './pluginGuide';

function FieldHelp({ text }: { text: string }) {
  const t = useTranslate();
  if (text.length <= 100) return <>{text}</>;
  const sentence = text.match(/^.{15,100}?[。；.!?](?:\s|$)?/u)?.[0] || text.slice(0, 85) + '…';
  return (
    <details className="plugin-field-help">
      <summary>
        {sentence} <span>{t('展开说明')}</span>
      </summary>
      <p>{text}</p>
    </details>
  );
}

function resolve(schema: JsonObject, root: JsonObject): JsonObject {
  if (schema.$ref?.startsWith('#/')) {
    const found = schema.$ref
      .slice(2)
      .split('/')
      .reduce(
        (node: JsonObject | undefined, key: string) =>
          node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
        root,
      );
    return found ? { ...found, ...schema, $ref: undefined } : schema;
  }
  return schema;
}
function typeOf(schema: JsonObject, value: unknown) {
  if (Array.isArray(schema.type))
    return schema.type.includes(Array.isArray(value) ? 'array' : typeof value)
      ? Array.isArray(value)
        ? 'array'
        : typeof value
      : schema.type[0];
  return schema.type || (schema.properties ? 'object' : schema.items ? 'array' : undefined);
}
function defaultFor(schema: JsonObject): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default);
  const choices = distinctTypes(schema);
  if (choices.length) return defaultFor(choices[0]);
  if (schema.anyOf?.some((part: JsonObject) => part.properties?.set && part.properties?.remove))
    return {};
  return schema.type === 'object' || schema.properties
    ? {}
    : schema.type === 'array'
      ? []
      : ['integer', 'number'].includes(schema.type)
        ? (schema.minimum ??
          (typeof schema.exclusiveMinimum === 'number'
            ? Math.floor(schema.exclusiveMinimum) + 1
            : 0))
        : schema.type === 'boolean'
          ? false
          : '';
}

function SecretInput({
  value,
  onChange,
  path,
  schema,
  readOnly,
  hasStoredValue,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  path: string;
  schema: JsonObject;
  readOnly: boolean;
  hasStoredValue: boolean;
}) {
  const t = useTranslate();
  const retained = useRef(value === KEEP_SECRET || hasStoredValue);
  const { message } = App.useApp();
  return (
    <div className="secret-field">
      <Input.Password
        aria-label={path}
        value={value === KEEP_SECRET ? '' : value}
        placeholder={retained.current ? t('已配置，留空保持原值') : t('请输入或生成凭据')}
        autoComplete="new-password"
        disabled={readOnly}
        onChange={(event) =>
          onChange(event.target.value || (retained.current ? KEEP_SECRET : undefined))
        }
      />
      <div className="secret-field-actions">
        <Button
          size="small"
          icon={<ReloadOutlined />}
          disabled={readOnly}
          aria-label={t('生成 {0}', path)}
          onClick={() => {
            const length =
              schema['x-secret-length'] ||
              Math.min(schema.maxLength || 64, Math.max(schema.minLength || 0, 32));
            const bytes = crypto.getRandomValues(new Uint8Array(length));
            const generated = Array.from(
              bytes,
              (byte) =>
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[byte & 63],
            ).join('');
            onChange(
              schema['x-base64']
                ? btoa(generated).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
                : generated,
            );
          }}
        >
          {t('生成')}
        </Button>
        <Button
          size="small"
          icon={<CopyOutlined />}
          disabled={!value || value === KEEP_SECRET}
          aria-label={t('复制 {0}', path)}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value!);
              message.success(t('已复制，请安全保存'));
            } catch {
              message.error(t('浏览器未允许访问剪贴板，请显示后手动复制'));
            }
          }}
        >
          {t('复制')}
        </Button>
        <span className="form-hint">
          {retained.current
            ? t('清空输入可保留原值；移除插件可撤销此凭据')
            : t('发布后只显示脱敏占位，请提前保存')}
        </span>
      </div>
    </div>
  );
}

function SchemaValue({
  schema: original,
  root,
  value,
  onChange,
  path,
  readOnly,
  depth,
}: {
  schema: JsonObject;
  root: JsonObject;
  value: any;
  onChange: (value: any) => void;
  path: string;
  readOnly: boolean;
  depth: number;
}) {
  const t = useTranslate();
  const schema = resolve(original, root);
  const type = typeOf(schema, value);
  if (
    path.split('.').at(-1) === 'headers' &&
    schema.anyOf?.length === 2 &&
    isObject(value) &&
    depth <= 5
  ) {
    const operations = schema.anyOf.find(
      (part: JsonObject) => part.properties?.set && part.properties?.remove,
    );
    if (
      operations &&
      Object.keys(value).every((key) => Object.hasOwn(operations.properties, key))
    ) {
      return (
        <SchemaFields
          schema={operations}
          root={root}
          prefix={path}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
          depth={depth + 1}
        />
      );
    }
  }
  const choices = distinctTypes(schema);
  if (
    choices.length &&
    depth <= 5 &&
    (value === undefined || choices.some((c) => typeMatches(c.type, value)))
  ) {
    const choice = choices.find((c) => typeMatches(c.type, value)) || choices[0];
    const { oneOf, anyOf, ...common } = schema;
    return (
      <div className="schema-variant">
        <Select
          aria-label={t('{0} 的值类型', path)}
          size="small"
          value={choice.type}
          disabled={readOnly}
          options={choices.map((c) => ({ value: c.type, label: c.type }))}
          onChange={(type) => onChange(defaultFor(choices.find((c) => c.type === type)!))}
        />
        <SchemaValue
          schema={{ ...common, ...choice }}
          root={root}
          value={value}
          path={path}
          readOnly={readOnly}
          depth={depth + 1}
          onChange={onChange}
        />
      </div>
    );
  }
  if (
    schema.$ref ||
    schema.oneOf ||
    schema.anyOf ||
    depth > 5 ||
    !type ||
    (value !== undefined && type === 'object' && !isObject(value)) ||
    (value !== undefined &&
      ['string', 'number', 'integer', 'boolean'].includes(type) &&
      typeof value !== (type === 'integer' ? 'number' : type))
  )
    return (
      <JsonField
        value={value ?? schema.default ?? {}}
        onChange={onChange}
        scope={`plugin.${path}`}
        label={`${path} JSON`}
        readOnly={readOnly}
        rows={4}
      />
    );
  if (schema.enum)
    return (
      <Select
        aria-label={path}
        getPopupContainer={(trigger) => trigger.parentElement!}
        value={value === undefined ? undefined : JSON.stringify(value)}
        allowClear
        options={schema.enum.map((option: unknown) => ({
          value: JSON.stringify(option),
          label: String(option),
        }))}
        onChange={(next) => onChange(next === undefined ? undefined : JSON.parse(next))}
        placeholder={schema.default === undefined ? t('未设置') : t('默认：{0}', schema.default)}
      />
    );
  if (type === 'boolean')
    return (
      <Select
        aria-label={path}
        getPopupContainer={(trigger) => trigger.parentElement!}
        value={value === undefined ? undefined : String(value)}
        allowClear
        options={[
          { value: 'true', label: t('启用 true') },
          { value: 'false', label: t('停用 false') },
        ]}
        onChange={(next) => onChange(next === undefined ? undefined : next === 'true')}
        placeholder={
          schema.default === undefined
            ? t('未设置')
            : t('默认：{0}', schema.default ? t('启用') : t('停用'))
        }
      />
    );
  if (type === 'integer' || type === 'number')
    return (
      <InputNumber
        aria-label={path}
        value={value}
        min={schema.minimum}
        max={schema.maximum}
        precision={type === 'integer' ? 0 : undefined}
        onChange={(next) => onChange(next === null ? undefined : next)}
        placeholder={schema.default === undefined ? t('未设置') : t('默认：{0}', schema.default)}
        style={{ width: '100%' }}
      />
    );
  if (type === 'string') {
    const isSecret =
      value === KEEP_SECRET ||
      schema.writeOnly ||
      schema.format === 'password' ||
      root.encrypt_fields?.includes(path) ||
      /password|secret|token|api_key|client_key/i.test(path);
    if (isSecret)
      return (
        <SecretInput
          value={value}
          onChange={onChange}
          path={path}
          schema={schema}
          readOnly={readOnly}
          hasStoredValue={root['x-retained-fields']?.includes(path) || false}
        />
      );
    if (
      /functions\[|body$|script$|_func$|public_key$/.test(path) ||
      String(value || '').includes('\n')
    )
      return (
        <Input.TextArea
          aria-label={path}
          className="mono"
          value={value}
          rows={5}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    return (
      <Input
        aria-label={path}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={schema.default === undefined ? t('未设置') : t('默认：{0}', schema.default)}
      />
    );
  }
  if (type === 'object' && schema.properties)
    return (
      <SchemaFields
        schema={schema}
        root={root}
        value={value || {}}
        onChange={onChange}
        prefix={path}
        readOnly={readOnly}
        depth={depth + 1}
      />
    );
  if (type === 'object' && schema.additionalProperties?.type === 'string')
    return (
      <KeyValueFields
        label={path}
        value={value || {}}
        onChange={onChange}
        scope={`plugin.${path}`}
        readOnly={readOnly}
      />
    );
  if (type === 'array' && schema.items && !Array.isArray(schema.items)) {
    if (value !== undefined && !Array.isArray(value))
      return (
        <JsonField
          value={value}
          onChange={onChange}
          label={`${path} JSON`}
          scope={`plugin.${path}`}
          readOnly={readOnly}
        />
      );
    const items = value || [];
    const itemSchema = resolve(schema.items, root);
    return (
      <div className="schema-array">
        {items.map((item: unknown, i: number) => (
          <div className="schema-array-item" key={i}>
            <div className="condition-title">
              <span>{t('第 {0} 项', i + 1)}</span>
              <Button
                type="text"
                danger
                disabled={readOnly}
                aria-label={t('移除 {0}[{1}]', path, i)}
                size="small"
                icon={<DeleteOutlined aria-hidden="true" />}
                onClick={() => onChange(items.filter((_: unknown, index: number) => index !== i))}
              />
            </div>
            <SchemaValue
              schema={itemSchema}
              root={root}
              path={`${path}[${i}]`}
              value={item}
              readOnly={readOnly}
              depth={depth + 1}
              onChange={(next) =>
                onChange(items.map((old: unknown, index: number) => (index === i ? next : old)))
              }
            />
          </div>
        ))}
        <Button
          type="dashed"
          icon={<PlusOutlined aria-hidden="true" />}
          disabled={readOnly || (schema.maxItems !== undefined && items.length >= schema.maxItems)}
          onClick={() => onChange([...items, defaultFor(itemSchema)])}
        >
          {t('添加 {0} 项', path)}
        </Button>
      </div>
    );
  }
  return (
    <JsonField
      value={value ?? (type === 'array' ? [] : {})}
      onChange={onChange}
      scope={`plugin.${path}`}
      label={`${path} JSON`}
      readOnly={readOnly}
      kind={type === 'object' || type === 'array' ? type : 'any'}
    />
  );
}

export function SchemaFields({
  schema,
  value,
  onChange,
  labels = {},
  prefix = '',
  root = schema,
  readOnly = false,
  depth = 0,
  filter = '',
}: {
  schema: JsonObject;
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  labels?: Record<string, string>;
  prefix?: string;
  root?: JsonObject;
  readOnly?: boolean;
  depth?: number;
  filter?: string;
}) {
  const t = useTranslate();
  const effective = activeSchema(schema, value);
  const groups = alternativeGroups(effective);
  const selected =
    groups.find((group) => group.every((key) => Object.hasOwn(value, key))) || groups[0] || [];
  const order = (key: string) =>
    effective.required?.includes(key)
      ? effective.required.indexOf(key)
      : selected.includes(key)
        ? 200 + selected.indexOf(key)
        : 1000;
  const properties = Object.entries(effective.properties || {})
    .filter(([key]) => key !== '_meta')
    .filter(
      ([key, field]) =>
        !filter ||
        [
          key,
          labels[key] && t(labels[key]),
          (field as JsonObject).description,
          root['x-field-help']?.[key],
        ].some((text) =>
          String(text || '')
            .toLowerCase()
            .includes(filter.trim().toLowerCase()),
        ),
    )
    .sort(([a], [b]) => order(a) - order(b));
  const patch = (key: string, next: unknown) => {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else result[key] = next;
    onChange(result);
  };
  return (
    <div className="schema-fields">
      {groups.length > 0 && (
        <div className="schema-alternatives">
          <strong>{t(effective.oneOf ? '选择一组配置' : '至少配置一组')}</strong>
          {groups.map((group, i) => (
            <Tag
              key={i}
              color={group.every((key) => Object.hasOwn(value, key)) ? 'green' : undefined}
            >
              {group.join(' + ')}
            </Tag>
          ))}
        </div>
      )}
      {properties.map(([key, def]) => {
        const field = resolve(def as JsonObject, root);
        const path = prefix ? `${prefix}.${key}` : key;
        const help = root['x-field-help']?.[path.replace(/\[\d+\]/g, '')] || field.description;
        const complex =
          ['object', 'array'].includes(typeOf(field, value[key])) ||
          ((field.anyOf || field.oneOf) && !distinctTypes(field).length) ||
          field.$ref;
        const required = effective.required?.includes(key);
        const label = (
          <span data-plugin-label={path}>
            {labels[key] ? t(labels[key]) : key}
            {labels[key] && <code className="field-code">{key}</code>}
          </span>
        );
        if (complex)
          return (
            <div className="schema-complex-field" key={key}>
              <Collapse
                defaultActiveKey={value[key] !== undefined ? [key] : []}
                items={[
                  {
                    key,
                    label: (
                      <Space>
                        {label}
                        {required && <Tag color="gold">{t('必填')}</Tag>}
                        {value[key] !== undefined && <Tag color="blue">{t('已配置')}</Tag>}
                      </Space>
                    ),
                    children: (
                      <>
                        {help && (
                          <div className="schema-description">
                            <FieldHelp text={String(help)} />
                          </div>
                        )}
                        {value[key] === undefined ? (
                          <Button disabled={readOnly} onClick={() => patch(key, defaultFor(field))}>
                            {t('配置')} {path}
                          </Button>
                        ) : (
                          <>
                            <SchemaValue
                              schema={field}
                              root={root}
                              value={value[key]}
                              onChange={(next) => patch(key, next)}
                              path={path}
                              readOnly={readOnly}
                              depth={depth}
                            />
                            <Button
                              className="schema-remove"
                              type="text"
                              danger
                              disabled={readOnly}
                              onClick={() => patch(key, undefined)}
                            >
                              {t('移除')} {path} {t('配置')}
                            </Button>
                          </>
                        )}
                      </>
                    ),
                  },
                ]}
              />
            </div>
          );
        return (
          <Form.Item
            key={key}
            label={label}
            required={required}
            extra={help ? <FieldHelp text={String(help)} /> : undefined}
          >
            <SchemaValue
              schema={field}
              root={root}
              value={value[key]}
              onChange={(next) => patch(key, next)}
              path={path}
              readOnly={readOnly}
              depth={depth}
            />
          </Form.Item>
        );
      })}
      {!properties.length && filter && (
        <span className="schema-alternatives">{t('没有匹配的配置项')}</span>
      )}
      {!properties.length && !filter && (
        <div className="schema-complex-field">
          <JsonField
            value={value}
            onChange={onChange}
            scope={`plugin.${prefix || 'root'}`}
            label={t('{0}配置 JSON', prefix || t('插件'))}
            readOnly={readOnly}
            kind="object"
          />
        </div>
      )}
    </div>
  );
}

import { useTranslate } from '../i18n';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Input, InputNumber, Switch } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { JsonObject } from '../types';
import { isObject } from './config';

export const BufferContext = createContext<(scope: string, error: string) => void>(() => {});
export function useBuffer(scope: string) {
  const report = useContext(BufferContext);
  useEffect(() => () => report(scope, ''), [report, scope]);
  return (error: string) => report(scope, error);
}

function useFieldIssue(scope: string, format: (key: string) => string) {
  const report = useContext(BufferContext);
  const [issue, setIssue] = useState('');
  const error = issue ? format(issue) : '';
  useEffect(() => {
    report(scope, error);
  }, [report, scope, error]);
  useEffect(() => () => report(scope, ''), [report, scope]);
  return [error, setIssue] as const;
}

function useRows<T>(value: unknown, initial: () => T, onReset: () => void) {
  const [rows, setRows] = useState(initial);
  const serialized = JSON.stringify(value);
  const last = useRef(serialized);
  useEffect(() => {
    if (serialized !== last.current) {
      last.current = serialized;
      setRows(initial());
      onReset();
    }
  }, [serialized]);
  return {
    rows,
    setRows,
    committed: (next: unknown) => {
      last.current = JSON.stringify(next);
    },
  };
}

export function KeyValueFields({
  value = {},
  onChange,
  scope,
  label,
  keyPlaceholder = '名称',
  valuePlaceholder = '值',
  readOnly = false,
  caseInsensitive = false,
}: {
  value?: JsonObject;
  onChange: (value: JsonObject) => void;
  scope: string;
  label: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  readOnly?: boolean;
  caseInsensitive?: boolean;
}) {
  const t = useTranslate();
  const [error, setError] = useFieldIssue(scope, (key) => t(key, label));
  const { rows, setRows, committed } = useRows(
    value,
    () =>
      Object.entries(isObject(value) ? value : {}).map(([key, val]) => ({
        key,
        value: String(val),
      })),
    () => {
      setError('');
    },
  );
  const complex = !isObject(value) || Object.values(value).some((val) => typeof val !== 'string');
  const change = (next: typeof rows) => {
    setRows(next);
    const message = next.some((row) => !row.key.trim())
      ? '{0}名称不能为空'
      : new Set(
            next.map((row) => (caseInsensitive ? row.key.trim().toLowerCase() : row.key.trim())),
          ).size !== next.length
        ? '{0}名称不能重复'
        : '';
    setError(message);
    if (!message) {
      const output = Object.fromEntries(next.map((row) => [row.key.trim(), row.value]));
      committed(output);
      onChange(output);
    }
  };
  if (complex)
    return (
      <JsonField
        value={value}
        onChange={onChange}
        scope={scope}
        label={label}
        readOnly={readOnly}
        kind="object"
      />
    );
  return (
    <div className="field-collection">
      {rows.map((row, i) => (
        <div className="key-value-row" key={i}>
          <Input
            aria-label={t('{0}名称 {1}', label, i + 1)}
            placeholder={t(keyPlaceholder)}
            value={row.key}
            disabled={readOnly}
            onChange={(event) =>
              change(rows.map((r, index) => (index === i ? { ...r, key: event.target.value } : r)))
            }
          />
          <Input
            aria-label={t('{0}值 {1}', label, i + 1)}
            placeholder={t(valuePlaceholder)}
            value={row.value}
            disabled={readOnly}
            onChange={(event) =>
              change(
                rows.map((r, index) => (index === i ? { ...r, value: event.target.value } : r)),
              )
            }
          />
          <Button
            type="text"
            danger
            disabled={readOnly}
            icon={<DeleteOutlined aria-hidden="true" />}
            aria-label={t('移除{0} {1}', label, i + 1)}
            onClick={() => change(rows.filter((_, index) => index !== i))}
          />
        </div>
      ))}
      <Button
        type="dashed"
        icon={<PlusOutlined aria-hidden="true" />}
        disabled={readOnly}
        onClick={() => change([...rows, { key: '', value: '' }])}
      >
        {t('添加{0}', label)}
      </Button>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function StringListField({
  value,
  onChange,
  scope,
  label,
  placeholder,
  readOnly = false,
  required = false,
  check,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  scope: string;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  check?: (item: string) => string;
}) {
  const t = useTranslate();
  const [error, setError] = useFieldIssue(scope, (key) => t(key, label));
  const { rows, setRows, committed } = useRows(
    value,
    () => (value.length ? [...value] : required ? [''] : []),
    () => {
      setError('');
    },
  );
  const change = (next: string[]) => {
    setRows(next);
    const normalized = next.map((item) => item.trim());
    const message = normalized.some((v) => !v)
      ? '{0}不能为空'
      : new Set(normalized).size !== normalized.length
        ? '{0}不能重复'
        : normalized.map((v) => check?.(v) || '').find(Boolean) || '';
    setError(message);
    if (!message) {
      committed(normalized);
      onChange(normalized);
    }
  };
  return (
    <div className="field-collection">
      {rows.map((row, index) => (
        <div className="string-list-row" key={index}>
          <span className="field-row-number">{String(index + 1).padStart(2, '0')}</span>
          <Input
            aria-label={`${label}${index === 0 ? '' : ` ${index + 1}`}`}
            className="mono"
            value={row}
            placeholder={placeholder}
            disabled={readOnly}
            onChange={(event) => change(rows.map((v, i) => (i === index ? event.target.value : v)))}
          />
          <Button
            type="text"
            danger
            disabled={readOnly || (required && rows.length === 1)}
            aria-label={t('移除{0} {1}', label, index + 1)}
            icon={<DeleteOutlined aria-hidden="true" />}
            onClick={() => change(rows.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button
        type="dashed"
        icon={<PlusOutlined aria-hidden="true" />}
        disabled={readOnly}
        onClick={() => change([...rows, ''])}
      >
        {t('添加{0}', label)}
      </Button>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function JsonField({
  value,
  onChange,
  scope,
  label,
  readOnly = false,
  kind = 'any',
  rows = 5,
}: {
  value: unknown;
  onChange: (value: any) => void;
  scope: string;
  label: string;
  readOnly?: boolean;
  kind?: 'any' | 'array' | 'object';
  rows?: number;
}) {
  const t = useTranslate();
  const current = JSON.stringify(value, null, 2) || '';
  const [text, setText] = useState(current);
  const [error, setError] = useFieldIssue(scope, (key) =>
    t(key, label, kind === 'array' ? t(' 数组') : kind === 'object' ? t(' 对象') : ''),
  );
  const last = useRef(current);
  useEffect(() => {
    if (last.current !== current) {
      setText(current);
      last.current = current;
      setError('');
    }
  }, [current]);
  return (
    <div className="json-field">
      <Input.TextArea
        aria-label={label}
        className="mono"
        value={text}
        rows={rows}
        disabled={readOnly}
        status={error ? 'error' : undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            if (
              (kind === 'array' && !Array.isArray(parsed)) ||
              (kind === 'object' &&
                (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'))
            )
              throw new Error();
            last.current = JSON.stringify(parsed, null, 2);
            onChange(parsed);
            setError('');
          } catch {
            const message = '{0}需要有效的 JSON{1}';
            setError(message);
          }
        }}
      />
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
  integer = false,
  extra,
}: {
  label: string;
  value?: number;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  extra?: string;
}) {
  const t = useTranslate();
  return (
    <Form.Item label={label} extra={extra}>
      <InputNumber
        aria-label={label}
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        precision={integer ? 0 : undefined}
        style={{ width: '100%' }}
        placeholder={t('网关默认')}
      />
    </Form.Item>
  );
}
export function ToggleSetting({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-setting">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <Switch aria-label={label} checked={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}
export function AdvancedNotice({ children }: { children: ReactNode }) {
  return <Alert type="info" showIcon title={children} />;
}

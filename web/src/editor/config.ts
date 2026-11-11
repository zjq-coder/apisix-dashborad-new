import type { JsonObject, ResourceKind } from '../types';
import { patchField } from '../config';
import { credentialIssues } from '../plugins';

export type EditorSection = 'match' | 'upstream' | 'traffic' | 'plugins' | 'review';
export interface ConfigIssue {
  path: string;
  message: string;
  section: EditorSection;
}
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Keep malformed imports editable in JSON without feeding invalid values to form controls.
export function formTypeErrors(kind: ResourceKind, value: JsonObject): ConfigIssue[] {
  const result: ConfigIssue[] = [];
  const check = (
    object: JsonObject,
    fields: Record<string, string>,
    prefix: string,
    section: EditorSection,
  ) => {
    for (const [key, type] of Object.entries(fields)) {
      const item = object[key];
      if (item === undefined) continue;
      const valid =
        type === 'object'
          ? isObject(item)
          : type === 'strings'
            ? Array.isArray(item) && item.every((v) => typeof v === 'string')
            : type === 'numbers'
              ? Array.isArray(item) &&
                item.every((v) => typeof v === 'number' && Number.isFinite(v))
              : typeof item === type;
      if (!valid)
        result.push({
          path: prefix + key,
          section,
          message: `${prefix}${key} 字段类型错误，请在 JSON 中修正`,
        });
    }
  };
  check(value, { name: 'string', desc: 'string', labels: 'object' }, '', 'match');
  if (kind === 'consumers') {
    check(value, { username: 'string', plugins: 'object' }, '', 'match');
    if (isObject(value.plugins)) {
      for (const [name, plugin] of Object.entries(value.plugins)) {
        if (!isObject(plugin))
          result.push({
            path: `plugins.${name}`,
            section: 'plugins',
            message: `插件 ${name} 必须是配置对象`,
          });
      }
      if (isObject(value.plugins['key-auth']))
        check(value.plugins['key-auth'], { key: 'string' }, 'plugins.key-auth.', 'plugins');
    }
    return result;
  }
  if (kind === 'routes') {
    const reference = value.plugin_config_id;
    if (
      reference !== undefined &&
      !(typeof reference === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(reference)) &&
      !(Number.isInteger(reference) && reference >= 1)
    )
      result.push({
        path: 'plugin_config_id',
        section: 'plugins',
        message: 'plugin_config_id 须为单个配置 ID，可在该共享配置中添加多个插件',
      });

    check(
      value,
      {
        uri: 'string',
        uris: 'strings',
        host: 'string',
        hosts: 'strings',
        remote_addr: 'string',
        remote_addrs: 'strings',
        methods: 'strings',
        priority: 'number',
        status: 'number',
        enable_websocket: 'boolean',
        upstream: 'object',
        plugins: 'object',
        filter_func: 'string',
      },
      '',
      'match',
    );
    if (isObject(value.plugins))
      for (const [name, plugin] of Object.entries(value.plugins)) {
        if (!isObject(plugin))
          result.push({
            path: `plugins.${name}`,
            section: 'plugins',
            message: `插件 ${name} 必须是配置对象`,
          });
        else if (['proxy-rewrite', 'redirect'].includes(name)) {
          check(
            plugin,
            {
              uri: 'string',
              regex_uri: 'strings',
              host: 'string',
              method: 'string',
              headers: 'object',
              _meta: 'object',
              http_to_https: 'boolean',
            },
            `plugins.${name}.`,
            'traffic',
          );
          if (isObject(plugin.headers) && ['set', 'add', 'remove'].some((k) => k in plugin.headers))
            check(
              plugin.headers,
              { set: 'object', add: 'object', remove: 'strings' },
              `plugins.${name}.headers.`,
              'traffic',
            );
        }
      }
  }
  const upstream = kind === 'upstreams' ? value : value.upstream;
  if (isObject(upstream)) {
    check(
      upstream,
      {
        type: 'string',
        scheme: 'string',
        pass_host: 'string',
        upstream_host: 'string',
        hash_on: 'string',
        key: 'string',
        service_name: 'string',
        discovery_type: 'string',
        timeout: 'object',
        keepalive_pool: 'object',
        checks: 'object',
        retries: 'number',
        retry_timeout: 'number',
      },
      'upstream.',
      'upstream',
    );
    if (
      upstream.nodes !== undefined &&
      !(
        isObject(upstream.nodes) ||
        (Array.isArray(upstream.nodes) && upstream.nodes.every(isObject))
      )
    )
      result.push({
        path: 'upstream.nodes',
        section: 'upstream',
        message: 'nodes 必须是节点权重对象或节点对象数组',
      });
    if (isObject(upstream.checks))
      for (const kind of ['active', 'passive']) {
        check(upstream.checks, { [kind]: 'object' }, 'checks.', 'upstream');
        const health = upstream.checks[kind];
        if (!isObject(health)) continue;
        check(
          health,
          {
            type: 'string',
            host: 'string',
            http_path: 'string',
            req_headers: 'strings',
            healthy: 'object',
            unhealthy: 'object',
          },
          `checks.${kind}.`,
          'upstream',
        );
        for (const state of ['healthy', 'unhealthy'])
          if (isObject(health[state]))
            check(
              health[state],
              { http_statuses: 'numbers' },
              `checks.${kind}.${state}.`,
              'upstream',
            );
      }
  }
  return result;
}
export const methods = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
  'PURGE',
];
export const operators = ['==', '~=', '>', '>=', '<', '<=', '~~', '~*', 'in', 'has', 'ipmatch'];
export const logicalOperators = ['AND', 'OR', '!AND', '!OR'];

export function matchValues(value: JsonObject, single: string, plural: string): string[] {
  return Array.isArray(value[plural])
    ? value[plural]
    : value[single] === undefined
      ? []
      : [value[single]];
}
export function setMatchValues(
  value: JsonObject,
  single: string,
  plural: string,
  entries: string[],
): JsonObject {
  const next = { ...value };
  delete next[single];
  delete next[plural];
  if (entries.length)
    next[entries.length > 1 || Array.isArray(value[plural]) ? plural : single] =
      entries.length > 1 || Array.isArray(value[plural]) ? entries : entries[0];
  return next;
}
export function updatePlugin(value: JsonObject, name: string, plugin?: JsonObject): JsonObject {
  const plugins = { ...(value.plugins || {}) };
  if (plugin === undefined) delete plugins[name];
  else plugins[name] = plugin;
  return { ...value, plugins };
}
export function setRewriteMode(value: JsonObject, mode: string): JsonObject {
  const next = { ...value };
  delete next.uri;
  delete next.regex_uri;
  if (mode === 'uri') next.uri = '';
  if (mode === 'regex') next.regex_uri = ['', ''];
  return next;
}
export function setRedirectMode(value: JsonObject, mode: string): JsonObject {
  const next = { ...value };
  delete next.uri;
  delete next.regex_uri;
  delete next.http_to_https;
  if (mode === 'https') {
    delete next.append_query_string;
    next.http_to_https = true;
  } else {
    if (mode === 'uri') next.uri = '';
    if (mode === 'regex') next.regex_uri = ['', ''];
  }
  return next;
}
export function structuredHeaders(value: JsonObject = {}): JsonObject {
  if (['set', 'add', 'remove'].some((key) => key in value)) return { ...value };
  return Object.keys(value).length ? { set: { ...value } } : {};
}
export function isIP(value: string): boolean {
  if (value.includes(':')) {
    try {
      return new URL(`http://[${value}]/`).hostname.startsWith('[');
    } catch {
      return false;
    }
  }
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((part) => Number(part) <= 255)
  );
}
export function isCIDR(value: string): boolean {
  const [address, mask, ...rest] = value.split('/');
  return (
    !rest.length &&
    isIP(address) &&
    (mask === undefined ||
      (/^\d+$/.test(mask) && Number(mask) <= (address.includes(':') ? 128 : 32)))
  );
}
export function parseNodeAddress(address: string): { host: string; port?: number } | null {
  if (!address || /\s|\/|@|\?|#/.test(address)) return null;
  let host = address,
    port: string | undefined;
  if (address.startsWith('[')) {
    const match = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match || !isIP(match[1])) return null;
    [, host, port] = match;
  } else if (address.includes(':')) {
    if (isIP(address)) return { host: address };
    const match = address.match(/^([^:]+):(\d+)$/);
    if (!match) return null;
    [, host, port] = match;
  }
  if (!host.includes(':') && !/^[a-zA-Z0-9_.-]+$/.test(host)) return null;
  if (/^[\d.]+$/.test(host) && !isIP(host)) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  return port === undefined ? { host } : { host, port: Number(port) };
}
export interface NodeRow {
  address: string;
  weight: number | null;
  extra: JsonObject;
}
export function nodeRows(value: JsonObject): NodeRow[] {
  return Array.isArray(value.nodes)
    ? value.nodes.map((item: unknown) => {
        const node = isObject(item) ? item : {};
        return {
          address: `${String(node.host || '').includes(':') ? `[${node.host}]` : node.host || ''}${node.port === undefined ? '' : `:${node.port}`}`,
          weight: node.weight,
          extra: { ...node },
        };
      })
    : Object.entries(isObject(value.nodes) ? value.nodes : {}).map(([address, weight]) => ({
        address,
        weight: typeof weight === 'number' ? weight : null,
        extra: {},
      }));
}
export function serializeNodes(rows: NodeRow[], arrayFormat: boolean): JsonObject['nodes'] {
  if (
    arrayFormat ||
    rows.some((r) => Object.keys(r.extra).some((key) => !['host', 'port', 'weight'].includes(key)))
  ) {
    return rows.map((row) => {
      const next = { ...row.extra, ...parseNodeAddress(row.address)!, weight: row.weight };
      if (parseNodeAddress(row.address)?.port === undefined) delete next.port;
      return next;
    });
  }
  return Object.fromEntries(rows.map((row) => [row.address, row.weight]));
}
export function expressionErrors(value: unknown, path = 'vars', depth = 0): string[] {
  if (depth > 12) return [`${path} 条件嵌套过深`];
  if (!Array.isArray(value)) return [`${path} 必须是条件数组`];
  if (!value.length) return [`${path} 条件不能为空；不限制时请移除 vars 字段`];
  if (typeof value[0] === 'string' && !logicalOperators.includes(value[0])) {
    const reversed = value[1] === '!';
    const op = value[reversed ? 2 : 1];
    const operand = value[reversed ? 3 : 2];
    if (value.length !== (reversed ? 4 : 3) || !operators.includes(op))
      return [`${path} 条件结构或运算符无效`];
    if (!/^[a-zA-Z_][\w.]*$/.test(value[0]) || /^(http_|arg_|post_arg_|cookie_)$/.test(value[0]))
      return [`${path} 请填写完整的变量名称`];
    if (['in', 'ipmatch'].includes(op) && (!Array.isArray(operand) || !operand.length))
      return [`${path} 的 ${op} 需要非空数组`];
    if (
      ['>', '>=', '<', '<='].includes(op) &&
      (typeof operand !== 'number' || !Number.isFinite(operand))
    )
      return [`${path} 数值比较需要数字`];
    if (
      op === 'ipmatch' &&
      operand.some((item: unknown) => typeof item !== 'string' || !isCIDR(item))
    )
      return [`${path} 请填写合法的 IP 或 CIDR`];
    if (['~~', '~*'].includes(op) && (typeof operand !== 'string' || !operand))
      return [`${path} 请填写正则表达式`];
    return [];
  }
  const start = typeof value[0] === 'string' ? 1 : 0;
  if (start && value.length < 3) return [`${path} 显式条件组至少需要两条规则`];
  return value
    .slice(start)
    .flatMap((node, i) => expressionErrors(node, `${path}[${i}]`, depth + 1));
}
export function validateConfig(kind: ResourceKind, value: JsonObject): ConfigIssue[] {
  const issues: ConfigIssue[] = formTypeErrors(kind, value);
  if (issues.length) return issues;
  const add = (path: string, message: string, section: EditorSection = 'match') =>
    issues.push({ path, message, section });
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 100))
    add('name', '名称须为不超过 100 字的文本');
  if (
    value.labels !== undefined &&
    (!value.labels ||
      Array.isArray(value.labels) ||
      typeof value.labels !== 'object' ||
      Object.entries(value.labels).some(([k, v]) => !k || typeof v !== 'string'))
  )
    add('labels', '标签必须为名称不为空的文本键值对');
  if (kind === 'consumers') {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value.username || ''))
      add('username', '消费者用户名须为 1–256 位字母、数字、下划线或短横线');
    const credential = value.plugins?.['key-auth'];
    if (credential && (typeof credential.key !== 'string' || !credential.key.trim()))
      add('plugins.key-auth.key', '请填写或生成 API Key', 'plugins');
    for (const [name, config] of Object.entries(value.plugins || {})) {
      if (isObject(config))
        for (const message of credentialIssues(name, config))
          add(`plugins.${name}`, message, 'plugins');
    }
    return issues;
  }
  if (kind === 'routes') {
    for (const [single, plural] of [
      ['uri', 'uris'],
      ['host', 'hosts'],
      ['remote_addr', 'remote_addrs'],
    ]) {
      if (single in value && plural in value) add(single, `${single} 与 ${plural} 不能同时配置`);
      if (plural in value && (!Array.isArray(value[plural]) || !value[plural].length))
        add(plural, `${plural} 必须是非空数组`);
      const entries = matchValues(value, single, plural);
      if (entries.some((entry) => typeof entry !== 'string' || !entry.trim()))
        add(plural, '匹配项不能为空');
      if (new Set(entries).size !== entries.length) add(plural, '匹配项不能重复');
    }
    const uris = matchValues(value, 'uri', 'uris');
    if (!uris.length || uris.some((uri) => typeof uri !== 'string' || !uri.startsWith('/')))
      add('uris', '至少填写一条以 / 开头的匹配路径');
    if (
      matchValues(value, 'remote_addr', 'remote_addrs').some(
        (ip) => typeof ip !== 'string' || !isCIDR(ip),
      )
    )
      add('remote_addrs', '客户端地址需要合法的 IPv4、IPv6 或 CIDR');
    if (
      value.methods !== undefined &&
      (!Array.isArray(value.methods) ||
        !value.methods.length ||
        value.methods.some((m: string) => !methods.includes(m)))
    )
      add('methods', 'HTTP 方法无效；不限制时请清空该字段');
    if (value.priority !== undefined && !Number.isInteger(value.priority))
      add('priority', '优先级必须是整数');
    if (value.vars !== undefined)
      expressionErrors(value.vars).forEach((message) => add('vars', message));
    if (value.upstream && value.upstream_id !== undefined)
      add('upstream', '内联上游与上游 ID 不能同时配置', 'upstream');
    for (const name of ['proxy-rewrite', 'redirect']) {
      const plugin = value.plugins?.[name];
      if (!plugin || plugin._meta?.disable) continue;
      if (
        name === 'redirect' &&
        [
          plugin.uri !== undefined,
          plugin.regex_uri !== undefined,
          plugin.http_to_https === true,
        ].filter(Boolean).length !== 1
      )
        add(`plugins.${name}`, '重定向必须选择且只能选择一种方式', 'traffic');
      if (plugin.uri !== undefined && (typeof plugin.uri !== 'string' || !plugin.uri))
        add(`plugins.${name}.uri`, '请填写目标路径', 'traffic');
      if (
        plugin.regex_uri !== undefined &&
        (!Array.isArray(plugin.regex_uri) ||
          plugin.regex_uri.length < 2 ||
          plugin.regex_uri.length % 2 ||
          (name === 'redirect' && plugin.regex_uri.length !== 2) ||
          plugin.regex_uri.some((v: unknown) => typeof v !== 'string' || !v))
      )
        add(`plugins.${name}.regex_uri`, '正则改写需要完整的匹配与替换对', 'traffic');
      if (name === 'redirect' && plugin.http_to_https && plugin.append_query_string !== undefined)
        add(`plugins.${name}`, 'HTTP 转 HTTPS 不能同时设置追加查询参数', 'traffic');
    }
  }
  const upstream = kind === 'upstreams' ? value : value.upstream;
  if (upstream) {
    if (upstream.discovery_type) {
      if (!upstream.service_name) add('service_name', '服务发现需要服务名称', 'upstream');
      if (upstream.nodes !== undefined) add('nodes', '服务发现与静态节点不能同时配置', 'upstream');
    } else {
      const rows = nodeRows(upstream);
      if (!rows.length) add('nodes', '请至少添加一个上游节点', 'upstream');
      rows.forEach((row, index) => {
        if (!parseNodeAddress(row.address))
          add('nodes', `第 ${index + 1} 个节点地址或端口无效`, 'upstream');
        if (row.weight === null || !Number.isInteger(row.weight) || row.weight < 0)
          add('nodes', `第 ${index + 1} 个节点权重需要非负整数`, 'upstream');
      });
      if (new Set(rows.map((r) => r.address)).size !== rows.length)
        add('nodes', '上游节点地址不能重复', 'upstream');
    }
    if (upstream.type === 'chash' && (upstream.hash_on || 'vars') !== 'consumer' && !upstream.key)
      add('key', '一致性哈希需要填写哈希键', 'upstream');
    if (upstream.pass_host === 'rewrite' && !upstream.upstream_host)
      add('upstream_host', '指定 Host 模式需要填写上游 Host', 'upstream');
    for (const [key, number] of Object.entries({
      ...upstream.timeout,
      retries: upstream.retries,
      retry_timeout: upstream.retry_timeout,
    })) {
      if (
        number !== undefined &&
        (typeof number !== 'number' || !Number.isFinite(number) || number < 0)
      )
        add(key, `${key} 需要非负数值`, 'upstream');
    }
    if (upstream.checks?.passive && !upstream.checks?.active)
      add('checks', '被动检查需要同时配置主动检查以恢复节点', 'upstream');
    for (const [kind, health] of Object.entries(upstream.checks || {}) as [string, JsonObject][]) {
      for (const state of ['healthy', 'unhealthy']) {
        for (const [key, number] of Object.entries(health[state] || {})) {
          if (key === 'http_statuses') {
            if (
              (number as number[]).some(
                (code) => !Number.isInteger(code) || code < 100 || code > 599,
              )
            )
              add('checks', '健康检查 HTTP 状态码须为 100–599 的整数', 'upstream');
          } else if (typeof number !== 'number' || !Number.isFinite(number) || number < 0)
            add('checks', `${kind}.${state}.${key} 需要非负数值`, 'upstream');
        }
      }
    }
  }
  return issues;
}

export function nestedField(
  value: JsonObject,
  parent: string,
  field: string,
  next: unknown,
): JsonObject {
  const nested = patchField(value[parent] || {}, field, next);
  return patchField(value, parent, Object.keys(nested).length ? nested : undefined);
}

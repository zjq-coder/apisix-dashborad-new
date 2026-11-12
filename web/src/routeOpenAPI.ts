import { parseDocument, stringify } from 'yaml';
import { cleanConfig } from './config';
import type { JsonObject, Resource } from './types';

const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const idPattern = /^[a-zA-Z0-9_.-]{1,64}$/;
const extensionFields = [
  'plugins',
  'script',
  'upstream',
  'upstream_id',
  'service_id',
  'plugin_config_id',
  'host',
  'hosts',
  'remote_addr',
  'remote_addrs',
  'priority',
  'vars',
  'filter_func',
  'labels',
  'enable_websocket',
  'status',
  'timeout',
];
const aliases: Record<string, string> = {
  'upstream-id': 'upstream_id',
  enableWebsocket: 'enable_websocket',
};
const object = (x: unknown): x is JsonObject =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
export const maxFileSize = 2 * 1024 * 1024;
export type RouteItem = { kind: 'routes'; id: string; value: JsonObject };

export function exportOpenAPI(routes: Resource[], title: string, format: string) {
  const paths: JsonObject = Object.create(null);
  const templates = new Map<string, string>();
  for (const { id, value } of routes) {
    for (const uri of value.uris || [value.uri]) {
      if (typeof uri !== 'string' || !uri.startsWith('/')) continue;
      let n = 0;
      const template = uri
        .replace(/\*/g, () => '{wildcard' + ++n + '}')
        .replace(/\/:([\w]+)/g, '/{$1}');
      const signature = template.replace(/\{[^{}]+\}/g, '{}');
      const path = templates.get(signature) ?? template;
      templates.set(signature, path);
      const item = (paths[path] ??= Object.create(null));
      const params = [...new Set(Array.from(path.matchAll(/\{([^{}]+)\}/g), (m) => m[1]))];
      if (params.length)
        item.parameters = params.map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }));
      const verbs: string[] = value.methods?.length
        ? value.methods.map((v: string) => v.toLowerCase())
        : methods;
      for (const verb of verbs.filter((v) => methods.includes(v))) {
        const op = (item[verb] ??= {
          summary: value.name || id,
          responses: { default: { description: 'Gateway response' } },
          'x-apisix-route-ids': [],
        });
        const ids: string[] = op['x-apisix-route-ids'];
        if (!ids.includes(id)) {
          ids.push(id);
          for (const field of extensionFields) {
            const key = 'x-apisix-' + field;
            if (ids.length === 1 && Object.hasOwn(value, field)) op[key] = value[field];
            else delete op[key];
          }
        }
      }
    }
  }
  const doc = {
    openapi: '3.0.3',
    info: { title, version: '1.0' },
    paths,
    'x-apisix-routes': routes.map((r) => ({ id: r.id, value: cleanConfig(r.value) })),
  };
  return format === 'yaml'
    ? stringify(doc, { aliasDuplicateObjects: false })
    : JSON.stringify(doc, null, 2);
}

function stableId(method: string, path: string) {
  let hash = 2166136261;
  for (const c of method + ' ' + path) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return 'oas-' + method + '-' + (hash >>> 0).toString(16);
}

function matchPath(path: string) {
  if (!/^\/[^?#*]*$/.test(path) || /[{}]/.test(path.replace(/\{[\w.-]+\}/g, '')))
    throw Error('OpenAPI 路径格式不受支持');
  const parts = path.split(/(\{[\w.-]+\})/);
  if (parts.length === 1) return { uri: path };
  const pattern = parts
    .map((part, i) => (i % 2 ? '[^/]+' : part.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&')))
    .join('');
  return { uri: parts[0] + '*', vars: [['uri', '~~', '^' + pattern + '$']] };
}

export function importOpenAPI(text: string, upstream: string): RouteItem[] {
  if (new Blob([text]).size > maxFileSize) throw Error('文件超过 2 MiB');
  const parsed = parseDocument(text, { prettyErrors: false });
  if (parsed.errors.length || parsed.warnings.length)
    throw Error('OpenAPI 文件不是有效的 JSON 或 YAML');
  let doc;
  try {
    doc = parsed.toJS({ maxAliasCount: 0 });
  } catch {
    throw Error('不支持 YAML 别名');
  }
  if (
    !object(doc) ||
    !/^3\.(0|1)\.\d+$/.test(doc.openapi) ||
    !object(doc.paths) ||
    !object(doc.info) ||
    !doc.info.title ||
    typeof doc.info.version !== 'string'
  )
    throw Error('请提供 OpenAPI 3.0 或 3.1 文档');
  const items: RouteItem[] = [];
  const seen = new Set<string>();
  function add(id: string, value: JsonObject) {
    if (typeof id !== 'string' || !idPattern.test(id) || seen.has(id))
      throw Error('路由 ID 无效或重复');
    if (items.length >= 50) throw Error('每次最多导入 50 条路由');
    seen.add(id);
    items.push({ kind: 'routes', id, value });
  }
  if (Object.hasOwn(doc, 'x-apisix-routes')) {
    if (!Array.isArray(doc['x-apisix-routes'])) throw Error('APISIX 路由扩展格式无效');
    for (const item of doc['x-apisix-routes']) {
      if (!object(item) || !object(item.value) || (!item.value.uri && !item.value.uris?.length))
        throw Error('APISIX 路由扩展格式无效');
      add(item.id, cleanConfig(item.value));
    }
  } else {
    for (const [path, item] of Object.entries(doc.paths)) {
      if (path.startsWith('x-')) continue;
      if (!object(item) || item.$ref || !path.startsWith('/')) throw Error('不支持路径或操作引用');
      for (const method of methods.filter((m) => Object.hasOwn(item, m))) {
        const op = item[method];
        if (!object(op) || op.$ref) throw Error('不支持路径或操作引用');
        const servers = op.servers ?? item.servers ?? doc.servers ?? [];
        if (!Array.isArray(servers) || servers.length > 1)
          throw Error('每个操作仅支持一个固定服务器地址');
        let prefix = '',
          host = '';
        if (servers.length) {
          const url = servers[0]?.url;
          if (
            typeof url !== 'string' ||
            /[{}?#]/.test(url) ||
            !/^(\/(?!\/)|https?:\/\/)/i.test(url)
          )
            throw Error('每个操作仅支持一个固定服务器地址');
          const server = new URL(url, 'https://relative.invalid');
          if (server.username || server.password) throw Error('每个操作仅支持一个固定服务器地址');
          prefix = server.pathname.replace(/\/$/, '');
          if (!url.startsWith('/')) host = server.hostname;
        }
        const id =
          op.operationId && idPattern.test(op.operationId)
            ? op.operationId
            : stableId(method, host + prefix + path);
        const ext: JsonObject = {};
        for (const [key, value] of Object.entries(op)) {
          if (!key.startsWith('x-apisix-') || key === 'x-apisix-route-ids') continue;
          const field = key.slice(9);
          const canonical = Object.hasOwn(aliases, field) ? aliases[field] : field;
          if (!extensionFields.includes(canonical)) throw Error('不支持的 APISIX 路由扩展字段');
          ext[canonical] = value;
        }
        if (!ext.upstream && !ext.upstream_id && !ext.service_id) {
          if (!upstream) throw Error('请为标准 OpenAPI 操作选择上游');
          ext.upstream_id = upstream;
        }
        const match = matchPath(prefix + path);
        if (match.vars && ext.vars) {
          if (!Array.isArray(ext.vars)) throw Error('APISIX 路由扩展格式无效');
          ext.vars = [...match.vars, ...ext.vars];
        }
        add(id, {
          name: op.summary || op.operationId || id,
          ...match,
          methods: [method.toUpperCase()],
          status: 0,
          ...(host && !ext.hosts ? { host } : {}),
          ...ext,
        });
      }
    }
  }
  if (!items.length) throw Error('文档中没有可导入的路由');
  return items;
}

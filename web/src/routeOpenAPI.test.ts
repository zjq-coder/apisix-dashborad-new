import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { exportOpenAPI, importOpenAPI } from './routeOpenAPI';
import type { Resource } from './types';
const base = {
  openapi: '3.0.3',
  info: { title: 'Store', version: '1' },
  paths: {
    '/pets/{id}': { get: { operationId: 'pet', responses: { default: { description: 'pet' } } } },
  },
};
const id = 'pet-route';
const r: Resource = {
  id,
  hash: 'h',
  modified_index: 1,
  value: {
    id,
    uri: '/pets/*',
    hosts: ['example.org'],
    plugin_config_id: 'shared',
    plugins: { 'request-id': {} },
    status: 0,
  },
};
describe('OpenAPI route exchange', () => {
  it.each(['json', 'yaml'])('round-trips full gateway settings in %s', (format) => {
    const doc = exportOpenAPI([r, { ...r, id: 'other' }], 'local', format);
    const parsed = parse(doc);
    expect(parsed.paths['/pets/{wildcard1}'].get['x-apisix-route-ids']).toEqual([id, 'other']);
    expect(parsed.paths['/pets/{wildcard1}'].parameters[0]).toMatchObject({
      name: 'wildcard1',
      required: true,
      in: 'path',
    });
    expect(importOpenAPI(doc, '').map((i) => i.id)).toEqual([id, 'other']);
    expect(importOpenAPI(doc, '')[0].value).toEqual({ ...r.value, id: undefined });
  });
  it('preserves uncommon methods and multiple URIs inside the extension', () => {
    const doc = exportOpenAPI(
      [{ ...r, value: { uris: ['/a', '/b'], methods: ['PURGE', 'HEAD'], priority: 5 } }],
      'local',
      'json',
    );
    expect(JSON.parse(doc).paths['/a'].head).toBeTruthy();
    expect(importOpenAPI(doc, '')[0].value.methods).toEqual(['PURGE', 'HEAD']);
  });
  it('writes legacy plugin fields for a single matching route and keeps equivalent path templates together', () => {
    const first = {
      ...r,
      value: {
        uri: '/:name',
        methods: ['GET', 'POST'],
        upstream_id: 'orders',
        plugins: { cors: {} },
      },
    };
    const second = {
      ...r,
      id: 'second',
      value: { uri: '/:id', methods: ['GET'], upstream_id: 'other' },
    };
    const yaml = exportOpenAPI([first, second], 'dev', 'yaml');
    const { paths } = parse(yaml);
    expect(Object.keys(paths)).toEqual(['/{name}']);
    expect(paths['/{name}'].post['x-apisix-plugins']).toEqual({ cors: {} });
    expect(paths['/{name}'].get['x-apisix-upstream_id']).toBeUndefined();
    expect(importOpenAPI(yaml, '')).toHaveLength(2);
  });
  it('converts each standard operation with a bounded path parameter and fixed server prefix', () => {
    const doc = { ...base, servers: [{ url: 'https://example.org/v1' }] };
    const [route] = importOpenAPI(JSON.stringify(doc), 'backend');
    expect(route.value).toMatchObject({
      uri: '/v1/pets/*',
      host: 'example.org',
      vars: [['uri', '~~', '^/v1/pets/[^/]+$']],
      upstream_id: 'backend',
      methods: ['GET'],
      status: 0,
    });
  });
  it('escapes regex literals and generates repeatable distinct IDs for verbs', () => {
    const input = JSON.stringify({ ...base, paths: { '/v1.0/{a}/{b}': { get: {}, post: {} } } });
    const result = importOpenAPI(input, 'x');
    expect(result).toEqual(importOpenAPI(input, 'x'));
    expect(result[0].id).not.toBe(result[1].id);
    const regex = new RegExp(result[0].value.vars[0][2]);
    expect(regex.test('/v1X0/a/b')).toBe(false);
    expect(regex.test('/v1.0/a/b')).toBe(true);
  });
  it('understands operation-level APISIX upstream and plugins', () => {
    const paths = {
      '/one': { get: { 'x-apisix-upstream-id': 'up', 'x-apisix-plugins': { cors: {} } } },
      '/two': { post: { 'x-apisix-upstream': { nodes: { 'echo:80': 1 } } } },
    };
    expect(importOpenAPI(JSON.stringify({ ...base, paths }), '').map((r) => r.value)).toMatchObject(
      [{ upstream_id: 'up', plugins: { cors: {} } }, { upstream: { nodes: { 'echo:80': 1 } } }],
    );
  });
  it('keeps legacy service references, host restrictions, websocket and additional predicates', () => {
    const op = {
      'x-apisix-service_id': 'orders',
      'x-apisix-hosts': ['api.example.org'],
      'x-apisix-status': 1,
      'x-apisix-enableWebsocket': true,
      'x-apisix-vars': [['arg_version', '==', '1']],
    };
    const result = importOpenAPI(
      JSON.stringify({ ...base, paths: { '/v/{id}': { get: op } } }),
      '',
    )[0].value;
    expect(result).toMatchObject({
      service_id: 'orders',
      hosts: ['api.example.org'],
      enable_websocket: true,
      status: 1,
      vars: [
        ['uri', '~~', '^/v/[^/]+$'],
        ['arg_version', '==', '1'],
      ],
    });
    expect(result).not.toHaveProperty('upstream_id');
    expect(() =>
      importOpenAPI(
        JSON.stringify({ ...base, paths: { '/v': { get: { 'x-apisix-unknown': 'x' } } } }),
        'up',
      ),
    ).toThrow('扩展字段');
  });
  it.each([
    [JSON.stringify(base), '', '选择上游'],
    [JSON.stringify({ ...base, openapi: '2.0' }), 'up', 'OpenAPI 3.0'],
    [JSON.stringify({ ...base, paths: { '/a': { $ref: 'external.yaml' } } }), 'up', '引用'],
    [JSON.stringify({ ...base, servers: [{ url: '/{env}' }] }), 'up', '服务器地址'],
    [JSON.stringify({ ...base, paths: {} }), 'up', '没有可导入'],
    [JSON.stringify({ ...base, 'x-apisix-routes': [r, r] }), 'up', '重复'],
    [JSON.stringify({ ...base, 'x-apisix-routes': null }), 'up', '扩展格式'],
    ['openapi: [', 'up', '有效的'],
    ['a: &a [1, 2]\nb: *a', 'up', '别名'],
    ['x'.repeat(2 * 1024 * 1024 + 1), 'up', '2 MiB'],
    [
      JSON.stringify({
        ...base,
        paths: Object.fromEntries(Array.from({ length: 51 }, (_, i) => ['/a' + i, { get: {} }])),
      }),
      'up',
      '50',
    ],
  ])('rejects unsupported input case %#', (input, up, reason) => {
    expect(() => importOpenAPI(input, up)).toThrow(reason);
  });
});

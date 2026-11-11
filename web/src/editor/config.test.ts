import { describe, expect, it } from 'vitest';
import {
  expressionErrors,
  formTypeErrors,
  isCIDR,
  nodeRows,
  parseNodeAddress,
  serializeNodes,
  setMatchValues,
  setRedirectMode,
  setRewriteMode,
  structuredHeaders,
  updatePlugin,
  validateConfig,
} from './config';

describe('route configuration round trips', () => {
  it('expands and clears singleton match fields without leaving aliases', () => {
    const original = { uri: '/a', future: { a: false } };
    const multi = setMatchValues(original, 'uri', 'uris', ['/a', '/b']);
    expect(multi).toEqual({ uris: ['/a', '/b'], future: { a: false } });
    expect(setMatchValues(multi, 'uri', 'uris', ['/b'])).toEqual({
      uris: ['/b'],
      future: { a: false },
    });
    expect(setMatchValues(multi, 'uri', 'uris', [])).toEqual({ future: { a: false } });
    expect(original.uri).toBe('/a');
  });
  it('preserves other plugins and nested metadata while updating rewrite settings', () => {
    const original = {
      plugins: {
        cors: { allow_origins: '*' },
        'proxy-rewrite': { uri: '/x', _meta: { priority: 0 } },
      },
    };
    const rewrite = setRewriteMode(original.plugins['proxy-rewrite'], 'regex');
    expect(updatePlugin(original, 'proxy-rewrite', rewrite).plugins).toEqual({
      cors: { allow_origins: '*' },
      'proxy-rewrite': { regex_uri: ['', ''], _meta: { priority: 0 } },
    });
    expect(updatePlugin(original, 'proxy-rewrite').plugins).toEqual({
      cors: { allow_origins: '*' },
    });
  });
  it('switches redirect modes without incompatible leftovers', () => {
    const original = { uri: '/old', append_query_string: true, _meta: { disable: false } };
    const https = setRedirectMode(original, 'https');
    expect(https).toEqual({ http_to_https: true, _meta: { disable: false } });
    expect(setRedirectMode(https, 'regex')).toEqual({
      regex_uri: ['', ''],
      _meta: { disable: false },
    });
  });
  it('converts legacy headers without losing their values', () => {
    expect(structuredHeaders({ 'X-A': 'one' })).toEqual({ set: { 'X-A': 'one' } });
    const current = { set: { 'X-A': ['one', 'two'] }, remove: ['X-B'] };
    expect(structuredHeaders(current)).toEqual(current);
  });
  it('keeps IPv6, priority zero and extra node metadata through node edits', () => {
    const original = {
      nodes: [{ host: '::1', port: 8080, weight: 0, priority: 0, metadata: { zone: 'a' } }],
    };
    const rows = nodeRows(original);
    expect(rows[0].address).toBe('[::1]:8080');
    expect(serializeNodes(rows, true)).toEqual(original.nodes);
    rows[0].address = 'echo';
    expect(serializeNodes(rows, true)).toEqual([
      { host: 'echo', weight: 0, priority: 0, metadata: { zone: 'a' } },
    ]);
  });
  it('promotes map nodes to array only when priority is configured', () => {
    const rows = nodeRows({ nodes: { 'echo:80': 1 } });
    expect(serializeNodes(rows, false)).toEqual({ 'echo:80': 1 });
    rows[0].extra.priority = -1;
    expect(serializeNodes(rows, false)).toEqual([
      { host: 'echo', port: 80, weight: 1, priority: -1 },
    ]);
  });
  it('accepts nested expressions, negation, number, null, and boolean operands without mutation', () => {
    const vars = [
      ['arg_count', '>=', 0],
      ['OR', ['http_x_flag', '!', '==', false], ['cookie_a', '==', null]],
      ['remote_addr', 'ipmatch', ['::1/128', '10.0.0.0/8']],
    ];
    const before = structuredClone(vars);
    expect(expressionErrors(vars)).toEqual([]);
    expect(vars).toEqual(before);
  });
  it.each([
    [['arg_', '==', 'x']],
    [['arg_count', '>', '1']],
    [['arg_x', 'in', 'a']],
    [['remote_addr', 'ipmatch', ['300.0.0.0']]],
    ['OR'],
    [['arg_x', 'unknown', 'a']],
  ])('rejects invalid expression %j', (...values) => {
    expect(expressionErrors(values)).not.toEqual([]);
  });
  it.each(['127.0.0.1', '10.2.0.0/16', '::1', '2001:db8::/64'])('accepts IP/CIDR %s', (value) =>
    expect(isCIDR(value)).toBe(true),
  );
  it.each(['127.0.0.999', '10.0.0.1/33', '::1/129', 'example.com', '10.0.0.1/-1'])(
    'rejects IP/CIDR %s',
    (value) => expect(isCIDR(value)).toBe(false),
  );
  it.each(['http://echo:80', 'echo:0', 'echo:65536', '[invalid]:80', 'a b:80'])(
    'rejects node address %s',
    (value) => expect(parseNodeAddress(value)).toBeNull(),
  );
  it('accepts valid complex inline upstream and preserves zero/false fields', () => {
    const value = {
      uri: '/a',
      status: 0,
      enable_websocket: false,
      priority: 0,
      upstream: {
        nodes: { 'echo:80': 0 },
        retries: 0,
        timeout: { connect: 0, send: 1, read: 2 },
        checks: { active: { healthy: { http_statuses: [200], successes: 0 } } },
      },
    };
    expect(validateConfig('routes', value)).toEqual([]);
  });
  it('reports mutually exclusive route fields and invalid health configuration', () => {
    const issues = validateConfig('routes', {
      uri: '/a',
      uris: ['/b'],
      upstream_id: 'x',
      upstream: {
        nodes: { 'echo:80': 1 },
        checks: { passive: { healthy: { http_statuses: [700] } } },
      },
    });
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['uri', 'upstream', 'checks']),
    );
  });
  it.each([
    { methods: 'GET' },
    { plugins: { redirect: null } },
    { upstream: { nodes: [null] } },
    { upstream: { checks: { active: { healthy: { http_statuses: ['wrong'] } } } } },
  ])('handles malformed imports without crashing %j', (value) => {
    expect(formTypeErrors('routes', { uri: '/x', ...value }).length).toBeGreaterThan(0);
    expect(() => validateConfig('routes', { uri: '/x', ...value })).not.toThrow();
  });
  it('does not coerce invalid node weights into valid zeros', () => {
    expect(
      validateConfig('upstreams', { nodes: { 'echo:80': null } }).some((i) =>
        i.message.includes('权重'),
      ),
    ).toBe(true);
    expect(nodeRows({ nodes: [null] })[0].address).toBe('');
  });
  it('rejects incomplete redirect pairs and incompatible HTTPS query settings', () => {
    expect(
      validateConfig('routes', {
        uri: '/x',
        plugins: {
          redirect: {
            http_to_https: true,
            append_query_string: false,
            regex_uri: ['a', 'b', 'c', 'd'],
          },
        },
      }).filter((i) => i.section === 'traffic').length,
    ).toBe(3);
  });
  it('rejects single-child explicit groups that APISIX rejects at runtime', () => {
    expect(expressionErrors(['OR', ['arg_a', '==', 'a']])[0]).toContain('至少需要两条');
    expect(expressionErrors([])).not.toEqual([]);
    expect(expressionErrors([['arg_a', '==', 'a']])).toEqual([]);
  });
  it('uses the route method enumeration rather than the proxy rewrite enumeration', () => {
    expect(validateConfig('routes', { uri: '/x', methods: ['PURGE'] })).toEqual([]);
    expect(
      validateConfig('routes', { uri: '/x', methods: ['MKCOL'] }).some(
        (issue) => issue.path === 'methods',
      ),
    ).toBe(true);
  });
});
describe('route shared plugin reference', () => {
  it.each(['policy-a', 23, undefined])('accepts the native scalar or absent ID %s', (id) => {
    expect(formTypeErrors('routes', { plugin_config_id: id })).toEqual([]);
  });
  it.each([[['policy-a', 'policy-b']], [{}], [null], [0], [1.5], ['']])(
    'reports invalid reference %j in the plugin panel',
    (id) => {
      expect(
        validateConfig('routes', { uri: '/test', upstream_id: 'up', plugin_config_id: id }),
      ).toContainEqual(expect.objectContaining({ path: 'plugin_config_id', section: 'plugins' }));
    },
  );
});

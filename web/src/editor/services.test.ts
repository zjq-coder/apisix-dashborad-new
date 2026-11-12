import { describe, expect, it } from 'vitest';
import { formTypeErrors, validateConfig } from './config';

describe('service configuration', () => {
  it.each([
    { name: '订单', upstream_id: 'blue.prod_01' },
    { upstream_id: 12 },
    { plugins: { 'request-id': {} } },
    { name: '服'.repeat(256), hosts: ['*.example.org', '[::1]', '*'], enable_websocket: false },
    {
      upstream: {
        nodes: [{ host: 'echo', port: 80, priority: 0, weight: 1 }],
        pass_host: 'rewrite',
        upstream_host: 'orders.example',
      },
    },
  ])('accepts APISIX service values %j', (value) => {
    expect(validateConfig('services', value)).toEqual([]);
  });
  it.each([
    [{ upstream_id: '', plugins: {} }, 'upstream_id'],
    [{ upstream: { nodes: { 'echo:80': 1 } }, upstream_id: 'a' }, 'upstream'],
    [{ upstream: { nodes: {} } }, 'nodes'],
    [{ name: 'x'.repeat(257) }, 'name'],
    [{ hosts: ['a.example', 'a.example'] }, 'hosts'],
    [{ hosts: ['https://a.example'] }, 'hosts'],
    [{ hosts: [] }, 'hosts'],
    [{ upstream: { type: 'chash', nodes: { 'echo:80': 1 } } }, 'key'],
  ] as const)('flags invalid service config %j', (value, field) => {
    expect(validateConfig('services', value).map((issue) => issue.path)).toContain(field);
  });
  it.each([
    { hosts: 'example.com' },
    { upstream: [] },
    { plugins: { cors: null } },
    { enable_websocket: 'false' },
    { upstream: { checks: { active: { healthy: { http_statuses: [{}] } } } } },
  ])('keeps malformed JSON out of the form %j', (value) => {
    expect(formTypeErrors('services', value).length).toBeGreaterThan(0);
  });
});

import { expect, it } from 'vitest';
import { routeCandidates } from './routeCandidates';
import type { Resource, JsonObject } from './types';
const route = (id: string, value: JsonObject): Resource => ({
  id,
  value,
  hash: '',
  modified_index: 0,
});
it('filters inactive routes, methods, wildcard domains and exact paths', () => {
  const list = [
    route('exact', { uri: '/v1', methods: ['GET'], hosts: ['*.example.org'] }),
    route('disabled', { uri: '/v1', status: 0 }),
    route('fallback', { uri: '/*' }),
    route('post', { uris: ['/v1', '/v2'], methods: ['POST'] }),
  ];
  expect(routeCandidates(list, 'get', 'a.example.org:80', '/v1?x=1').map((r) => r.id)).toEqual([
    'exact',
    'fallback',
  ]);
  expect(routeCandidates(list, 'get', 'example.org', '/v1').map((r) => r.id)).toEqual(['fallback']);
  expect(routeCandidates(list, 'POST', '', '/v2').map((r) => r.id)).toEqual(['post', 'fallback']);
});
it('retains conditional candidates and distinguishes parameterized paths', () => {
  const list = [
    route('param', { uri: '/v1/:name', vars: [['arg_test', '==', 'x']], priority: 8 }),
    route('prefix', { uri: '/v1/*', priority: 1 }),
  ];
  expect(routeCandidates(list, 'GET', '', '/v1/a')[0].conditions).toEqual([
    'vars',
    'radixtree_uri_with_parameter',
  ]);
  expect(routeCandidates(list, 'GET', '', '/v1/a/b').map((r) => r.id)).toEqual(['prefix']);
});

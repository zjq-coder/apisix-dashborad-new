import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';

// Read-only post-regression check; inspect current configuration without restoring stale examples.
const { request, gateway } = await sandboxClient();
const cluster = (await request('/clusters')).find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
assert.ok(cluster && !cluster.read_only);
const saved = JSON.parse(await readFile('.local/health-check-client.json', 'utf8'));
const consumer = await gateway(`/consumers/${saved.username}`);
assert.equal(consumer.status, 200);
const currentKey = consumer.data.value.plugins['key-auth'].key;
assert.ok(typeof currentKey === 'string' && currentKey.length > 0);
const health = await gateway('/routes/sandbox-health');
assert.equal(health.status, 200);
assert.equal(health.data.value.name, 'health-check');
assert.equal(health.data.value.uri, '/health');
assert.ok(health.data.value.plugins['key-auth']);
const limiter = health.data.value.plugins['limit-count'];
const authenticatedStatuses =
  limiter && !limiter._meta?.disable ? [200, limiter.rejected_code || 503] : [200];
const results = [];
for (const [name, path, headers, expected] of [
  ['missing', '/health', {}, [401]],
  ['invalid', '/health', { apikey: 'invalid-final-check' }, [401]],
  ['current-header-key', '/health', { apikey: currentKey }, authenticatedStatuses],
  [
    'current-query-key',
    `/health?apikey=${encodeURIComponent(currentKey)}`,
    {},
    authenticatedStatuses,
  ],
]) {
  const response = await sandboxProxy(path, { headers });
  const body = await response.text();
  assert.ok(expected.includes(response.status), `${name}: unexpected HTTP ${response.status}`);
  if (
    limiter &&
    response.status !== 200 &&
    expected === authenticatedStatuses &&
    limiter.rejected_msg
  ) {
    let detail = body;
    try {
      detail = JSON.parse(body).error_msg || body;
    } catch {
      /* Some gateway versions return plain text. */
    }
    assert.ok(detail === limiter.rejected_msg, 'Unexpected limiter response');
  }
  results.push({ name, status: response.status });
}
const counts = {},
  temporary = [];
for (const kind of ['routes', 'consumers', 'upstreams']) {
  const list = await request(`/clusters/${cluster.id}/resources/${kind}`);
  counts[kind] = list.total;
  temporary.push(
    ...list.items
      .filter((item) => /^(auth-(?:ui-)?\d+|consumer-check-\d+|consumer-ui-\d+)/.test(item.id))
      .map((item) => `${kind}/${item.id}`),
  );
}
const drafts = await request(`/drafts?cluster_id=${cluster.id}`);
const pending = drafts.filter(
  (d) => d.status === 'draft' && /^(auth-|consumer-check-|consumer-ui-)/.test(d.resource_id),
);
assert.deepEqual(temporary, []);
assert.deepEqual(
  pending.map((d) => d.resource_id),
  [],
);
const result = {
  at: new Date().toISOString(),
  historicalExampleMatchesCurrentCredential: currentKey === saved.key,
  currentCredentialAuthenticated: true,
  consumerUpdatedAt: new Date(consumer.data.value.update_time * 1000).toISOString(),
  routeUpdatedAt: new Date(health.data.value.update_time * 1000).toISOString(),
  existingRateLimit: limiter
    ? {
        count: limiter.count,
        timeWindowSeconds: limiter.time_window,
        rejectedCode: limiter.rejected_code,
      }
    : null,
  health: results,
  resourceCounts: counts,
  temporaryResources: temporary,
  pendingTestDrafts: pending.length,
  readOnly: cluster.read_only,
};
await writeFile('.local/consumer-plugin-final-check.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

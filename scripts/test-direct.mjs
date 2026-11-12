// Run with tests/stream/direct.yaml. Every service is on an isolated Docker network.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const base = 'http://console:8080/api/v1';
const id = 'direct-' + randomBytes(5).toString('hex');
const password = 'direct-fixture-only';
const secret = randomBytes(24).toString('hex');
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
async function eventually(check) {
  let error;
  for (let i = 0; i < 80; i++) {
    try {
      return await check();
    } catch (e) {
      error = e;
      await sleep(250);
    }
  }
  throw error;
}
await eventually(async () => {
  assert.ok((await fetch('http://console:8080/healthz')).ok);
  assert.ok(
    (
      await fetch('http://gateway:9180/apisix/admin/routes', {
        headers: { 'X-API-KEY': 'isolated-stream-fixture' },
      })
    ).ok,
  );
});
async function login(username) {
  const r = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0],
    csrf = (await r.json()).csrf_token;
  return async (path, method = 'GET', data, status = 200, headers = {}) => {
    const resp = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const out = await resp.json();
    assert.ok(!JSON.stringify(out).includes(secret), 'protected value in response');
    assert.equal(resp.status, status, method + ' ' + path + ' ' + (out.error || ''));
    return out;
  };
}
const admin = await login('fixture-admin');
const target = await admin('/clusters', 'POST', {
  name: '验收生产',
  environment: 'production',
  url: 'http://gateway:9180',
  api_key: 'isolated-stream-fixture',
});
const prefix = '/clusters/' + target.id;
const confirm = { 'X-Confirm-Cluster': encodeURIComponent(target.name) };
const entry = (kind, key = id) =>
  admin(prefix + '/resources/' + kind + '/' + encodeURIComponent(key));
async function done(ch, expected = 'succeeded') {
  const result = await eventually(async () => {
    const c = await admin('/changesets/' + ch.id);
    assert.notEqual(c.status, 'publishing');
    return c;
  });
  assert.equal(
    result.status,
    expected,
    result.operations.map((o) => o.resource_type + ' ' + o.error).join(', '),
  );
  return result;
}
const submit = (body) => admin(prefix + '/config/apply', 'POST', body, 201, confirm);
const save = async (body) => {
  const c = await done(await submit(body));
  assert.equal(c.operations.length, 1);
  assert.equal(c.operations[0].draft_id, '');
  assert.equal(c.operations[0].status, 'applied');
  return c;
};
const keyRoute = {
  uri: '/' + id,
  upstream_id: id,
  plugin_config_id: id,
  plugins: { 'proxy-rewrite': { uri: '/' } },
};
const first = {
  resource_type: 'upstreams',
  resource_id: id,
  action: 'create',
  value: { type: 'roundrobin', nodes: { 'echo:80': 1 } },
};
await admin(prefix + '/config/apply', 'POST', first, 400);
await admin(prefix + '/config/apply', 'POST', first, 400, { 'X-Confirm-Cluster': 'wrong' });
await admin(prefix + '/config/apply', 'POST', { ...first, cluster_id: 'other' }, 400, confirm);
pass('production confirmation and cluster identity');
const responseHeader = (v) => ({
  plugins: { 'response-rewrite': { headers: { set: { 'X-Direct-Test': v } } } },
});
const fixtures = [
  ['upstreams', id, first.value, { nodes: { 'echo:80': 2 } }],
  ['consumer_groups', id, { plugins: {} }, { desc: 'updated' }],
  ['consumers', id, { username: id, group_id: id }, { desc: 'updated' }],
  [
    'credentials',
    id + ':key',
    { plugins: { 'key-auth': { key: secret + '-initial' } } },
    { plugins: { 'key-auth': { key: secret } } },
  ],
  [
    'secrets',
    'vault:' + id,
    { uri: 'http://vault.invalid', prefix: '/kv', token: secret },
    { prefix: '/new' },
  ],
  ['plugin_configs', id, { plugins: { 'key-auth': {} } }, { desc: 'updated' }],
  ['global_rules', id, responseHeader('before'), responseHeader('after')],
  [
    'plugin_metadata',
    'http-logger',
    { log_format: { host: '$host' } },
    { log_format: { path: '$uri' } },
  ],
  ['services', id, { upstream_id: id }, { desc: 'updated' }],
  [
    'protos',
    id,
    { content: 'syntax = "proto3"; message A {}' },
    { content: 'syntax = "proto3"; message B {}' },
  ],
  ['stream_routes', id, { server_port: 9100, upstream_id: id }, { remote_addr: '0.0.0.0/0' }],
  ['routes', id, keyRoute, { service_id: id, desc: 'updated' }],
];
for (const [kind, key, value, patch] of fixtures) {
  const body = { resource_type: kind, resource_id: key, action: 'create', value };
  await save(body);
  const old = await entry(kind, key);
  const updated = { ...old.value, ...patch };
  if (kind === 'routes') delete updated.upstream_id;
  const validated = await admin(prefix + '/validate', 'POST', {
    resource_type: kind,
    resource_id: key,
    value: updated,
    include_diff: true,
  });
  assert.ok(validated.ok && validated.preview.diff.length);
  assert.equal((await entry(kind, key)).hash, old.hash);
  const changed = await save({ ...body, action: 'update', base_hash: old.hash, value: updated });
  assert.ok(changed.operations[0].diff.length);
  assert.notEqual((await entry(kind, key)).hash, old.hash);
  pass(kind + ' create, masked read, update, diff and readback');
}
const traffic = async (port, path, status, headers = {}) =>
  eventually(async () => {
    const r = await fetch('http://gateway:' + port + path, { headers });
    assert.equal(r.status, status);
    return r.headers;
  });
await traffic(9100, '/', 200);
await traffic(9080, '/' + id, 401);
assert.equal(
  (await traffic(9080, '/' + id, 200, { apikey: secret })).get('x-direct-test'),
  'after',
);
pass('TCP forwarding, HTTP authentication and global response plugin');
const snapshot = await entry('routes');
const edit = {
  resource_type: 'routes',
  resource_id: id,
  action: 'update',
  base_hash: snapshot.hash,
  value: { ...snapshot.value, status: 0 },
};
await admin(prefix + '/config/apply', 'POST', { ...edit, base_hash: 'stale' }, 409, confirm);
const invalid = await done(
  await submit({ ...edit, value: { ...edit.value, service_id: 'missing-resource' } }),
  'failed',
);
assert.equal(invalid.operations[0].status, 'skipped');
assert.equal((await entry('routes')).hash, snapshot.hash);
await admin(prefix + '/config/apply', 'POST', { ...first, resource_type: 'ssls' }, 400, confirm);
pass('stale baseline, missing dependency and read-only TLS inventory');
await admin(
  '/users',
  'POST',
  { username: id, password, role: 'member', enabled: true, grants: { [target.id]: ['edit'] } },
  201,
);
const editor = await login(id);
await editor(prefix + '/config/apply', 'POST', edit, 403, confirm);
const pending = await editor(prefix + '/config/submit', 'POST', edit, 201);
assert.equal(pending.status, 'pending');
await editor('/changesets/' + pending.id + '/publish', 'POST', {}, 403);
await traffic(9080, '/' + id, 200, { apikey: secret });
assert.deepEqual(await admin('/drafts?cluster_id=' + target.id), []);
await admin('/changesets/' + pending.id + '/publish', 'POST', {}, 202);
await done(pending);
await traffic(9080, '/' + id, 404);
const undo = await admin('/changesets/' + pending.id + '/rollback', 'POST', {}, 201);
await admin('/changesets/' + undo.id + '/publish', 'POST', {}, 202);
await done(undo);
await traffic(9080, '/' + id, 200, { apikey: secret });
pass('edit-only submission, publisher handoff, no drafts and rollback');
const current = await entry('routes');
const d = await admin('/drafts', 'POST', {
  ...edit,
  cluster_id: target.id,
  base_hash: current.hash,
});
const fromLegacy = { ...edit, base_hash: current.hash, draft_id: d.id, revision: d.revision };
await admin(
  prefix + '/config/apply',
  'POST',
  { ...fromLegacy, revision: d.revision - 1 },
  409,
  confirm,
);
const resumed = await done(await submit(fromLegacy));
assert.equal(resumed.operations[0].draft_id, d.id);
assert.equal((await admin('/drafts/' + d.id)).status, 'published');
pass('legacy draft revision and direct publication');
for (const [kind, key] of fixtures.toReversed()) {
  const r = await entry(kind, key);
  await save({ resource_type: kind, resource_id: key, action: 'delete', base_hash: r.hash });
  await admin(prefix + '/resources/' + kind + '/' + encodeURIComponent(key), 'GET', undefined, 404);
  pass(kind + ' delete and verify absence');
}
const audit = await admin('/audit?cluster_id=' + target.id);
assert.ok(audit.some((a) => a.action === 'config.save' && a.actor === id));
assert.ok(audit.some((a) => a.action === 'change.succeeded'));
pass('authenticated audit attribution and terminal outcome');
console.log(checks.length + ' direct configuration checks passed');

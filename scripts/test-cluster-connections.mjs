import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';

const { request, config, gateway, waitChange } = await sandboxClient();
const name = 'cluster-check-' + randomBytes(5).toString('hex');
const peerFile = fileURLToPath(new URL('./fixtures/cluster-probe-peer.mjs', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const control = (state) =>
  JSON.parse(
    docker(
      'exec',
      name,
      'node',
      '--input-type=module',
      '-e',
      "const state=process.argv[1];const r=await fetch('http://127.0.0.1:8080/control/'+state,{method:state==='stats'?'GET':'POST'});console.log(await r.text())",
      state,
    ),
  );
let connection, member;
const input = {
  name,
  environment: 'staging',
  url: 'http://' + name + ':8080',
  api_key: config.APISIX_ADMIN_KEY,
  read_only: true,
};
const cluster = () => '/clusters/' + connection.id;
async function waitHealth(status, previous) {
  const deadline = Date.now() + 85_000;
  while (Date.now() < deadline) {
    const row = (await request('/clusters')).find((c) => c.id === connection.id);
    if (row?.status === status && row.last_checked && row.last_checked !== previous) {
      assert.ok(Number.isInteger(row.probe_latency_ms));
      console.log('PASS automatic', status, row.last_checked, row.probe_latency_ms + ' ms');
      return row;
    }
    await sleep(1200);
  }
  throw new Error('Timed out waiting for automatic ' + status);
}
const baseline = await gateway('/routes/sandbox-orders-api');
assert.equal(baseline.status, 200);
assert.equal((await sandboxProxy('/api/orders/check')).status, 200);
docker(
  'run',
  '-d',
  '--rm',
  '--name',
  name,
  '--network',
  'apisix-dashboard-next_default',
  '--mount',
  'type=bind,source=' + peerFile + ',target=/peer.mjs,readonly',
  'node:24-bookworm-slim',
  'node',
  '/peer.mjs',
);
try {
  connection = await request('/clusters', 'POST', input);
  const initial = await waitHealth('connected');
  assert.match(initial.version, /^3\./);
  assert.ok(!initial.probe_error);
  control('down');
  const offline = await waitHealth('error', initial.last_checked);
  assert.match(offline.probe_error, /Admin API/);
  control('up');
  const recovered = await waitHealth('connected', offline.last_checked);
  assert.ok(!recovered.probe_error);
  const beats = control('stats');
  assert.ok(beats.length >= 3);
  assert.ok(beats.every((r) => r.method === 'GET' && r.path === '/apisix/admin/plugins/list'));
  console.log('PASS unattended outage and recovery, only GET plugins/list', beats.length);
  const manual = await request(cluster() + '/probe', 'POST');
  assert.ok(manual.ok && manual.routes > 0 && manual.upstreams > 0 && manual.plugins > 0);
  assert.deepEqual(
    control('stats')
      .slice(-3)
      .map((r) => r.path),
    [
      '/apisix/admin/plugins/list',
      '/apisix/admin/routes?page=1&page_size=10',
      '/apisix/admin/upstreams?page=1&page_size=10',
    ],
  );
  const changed = await request(cluster(), 'PUT', {
    ...input,
    api_key: randomBytes(18).toString('hex'),
  });
  assert.equal(changed.last_checked, null);
  const invalid = await waitHealth('error');
  assert.match(invalid.probe_error, /HTTP (401|403)/);
  await request(cluster(), 'PUT', input);
  await waitHealth('connected');
  console.log('PASS manual capability checks and real APISIX key rejection/recovery');
  const password = randomBytes(16).toString('hex');
  member = await request('/users', 'POST', {
    username: name,
    password,
    enabled: true,
    role: 'member',
    grants: { [connection.id]: ['edit', 'audit'] },
  });
  const base = 'http://127.0.0.1:18080/api/v1';
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password }),
  });
  assert.equal(login.status, 200);
  const memberHeaders = {
    Cookie: login.headers.get('set-cookie').split(';')[0],
    'X-CSRF-Token': (await login.json()).csrf_token,
  };
  assert.equal(
    (await fetch(base + cluster(), { method: 'DELETE', headers: memberHeaders })).status,
    403,
  );
  assert.equal((await fetch(base + cluster(), { method: 'DELETE' })).status, 401);
  const originalPath = cluster();
  await request(originalPath, 'PUT', { ...input, read_only: false });
  const draft = await request('/drafts', 'POST', {
    cluster_id: connection.id,
    resource_type: 'upstreams',
    resource_id: name,
    action: 'create',
    value: { type: 'roundrobin', nodes: { 'echo:80': 1 } },
  });
  const change = await request('/changesets', 'POST', {
    draft_ids: [draft.id],
    reason: '验证发布中禁止移除连接',
  });
  control('slow');
  await request('/changesets/' + change.id + '/publish', 'POST');
  await assert.rejects(request(originalPath, 'DELETE'), { status: 409 });
  control('up');
  // The peer rejects writes, so the normal publication worker finishes without changing the gateway.
  assert.equal((await waitChange(change.id)).status, 'failed');
  assert.equal((await gateway('/upstreams/' + name)).status, 404);
  await request(originalPath, 'PUT', input);
  await waitHealth('connected');
  const beforeDelete = control('stats');
  await request(originalPath, 'DELETE');
  assert.ok(!(await request('/clusters')).some((c) => c.id === connection.id));
  assert.deepEqual(await (await fetch(base + '/clusters', { headers: memberHeaders })).json(), []);
  assert.deepEqual((await request('/users')).find((u) => u.username === name).grants, {});
  const audit = await request(
    '/audit?cluster_id=' + connection.id + '&action=cluster.delete&outcome=success',
  );
  assert.ok(audit.some((e) => e.target === connection.id));
  assert.equal((await request('/changesets/' + change.id)).status, 'failed');
  console.log(
    'PASS active release refused removal with 409, history retained after release completed',
  );
  for (const [path, method, data] of [
    [originalPath, 'DELETE'],
    [originalPath + '/workspace', 'GET'],
    [originalPath + '/probe', 'POST'],
    [originalPath, 'PUT', input],
  ]) {
    await assert.rejects(request(path, method, data), { status: 404 });
  }
  connection = null;
  assert.deepEqual((await gateway('/routes/sandbox-orders-api')).data, baseline.data);
  assert.equal((await sandboxProxy('/api/orders/check')).status, 200);
  console.log(
    'PASS delete privileges, old URLs, grant removal, audit, route configuration and business HTTP 200',
  );
  await sleep(70_000);
  assert.deepEqual(control('stats'), beforeDelete);
  console.log('PASS zero subsequent requests for 70 seconds after removal');
} finally {
  try {
    if (connection) await request(cluster(), 'DELETE');
  } finally {
    try {
      if (member) await request('/users/' + name, 'DELETE', { revision: member.revision });
    } finally {
      docker('stop', name);
    }
  }
}

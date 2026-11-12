import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';

// Run against the local Compose development sandbox. Each run owns its two backends.
const exec = promisify(execFile);
const docker = async (...args) =>
  (await exec('docker', args, { windowsHide: true, timeout: 15000 })).stdout.trim();
const run = 'svc-hc-' + randomUUID().slice(0, 12);
const algorithm = process.argv.includes('--chash') ? 'chash' : 'roundrobin';
const network = 'apisix-dashboard-next_default';
const fixture = fileURLToPath(new URL('./fixtures/service-health.conf', import.meta.url));
const evidenceDir = new URL('../.local/service-health/', import.meta.url);
const report = {
  run,
  algorithm,
  started: new Date().toISOString(),
  scenarios: {},
  failoverExceptions: [],
  cleanup: [],
};
const { request, gateway, waitChange } = await sandboxClient();
const cluster = (await request('/clusters')).find(
  (c) => c.environment === 'development' && c.url === 'http://apisix:9180/apisix/admin',
);
assert.ok(cluster && !cluster.read_only, 'Writable local Compose development cluster required');
const gw = await docker('compose', 'ps', '-q', 'apisix');
const echo = await docker('compose', 'ps', '-q', 'echo');
assert.ok(gw && echo, 'Start the local gateway profile first');
report.gateway = await docker('inspect', '-f', '{{.Config.Image}}', gw);
report.imageId = await docker('inspect', '-f', '{{.Image}}', gw);
const image = await docker('inspect', '-f', '{{.Image}}', echo);
const backends = {};
const owned = new Set();
let paused = false;

// Control API listens only on the gateway's loopback. Do not expose it on the host.
async function getInside(host, port, path) {
  const raw = await docker(
    'exec',
    gw,
    'bash',
    '-ec',
    'exec 3<>/dev/tcp/"$1"/"$2"; printf "GET %s HTTP/1.0\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" "$3" >&3; cat <&3',
    'read-health',
    host,
    String(port),
    path,
  );
  const [headers, body] = raw.split(/\r?\n\r?\n/);
  return { status: Number(headers.split(' ')[1]), body };
}
async function startBackend(name) {
  const id = await docker(
    'run',
    '-d',
    '--pull=never',
    '--network',
    network,
    '--name',
    run + '-' + name,
    '--hostname',
    name,
    '--mount',
    'type=bind,source=' + fixture + ',target=/etc/nginx/conf.d/default.conf,readonly',
    image,
  );
  backends[name] = { id };
  const ip = await docker(
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    id,
  );
  assert.ok(isIPv4(ip), 'Expected a local bridge IPv4 address');
  backends[name].ip = ip;
}
async function publish(kind, id, value) {
  const path = '/' + kind + '/' + id;
  assert.equal((await gateway(path)).status, 404);
  owned.add(path);
  const change = await request('/clusters/' + cluster.id + '/config/apply', 'POST', {
    resource_type: kind,
    resource_id: id,
    action: 'create',
    value,
  });
  const done = await waitChange(change.id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.operations.map((o) => o.error)));
  const stored = await gateway(path);
  assert.equal(stored.status, 200);
  assert.partialDeepStrictEqual(stored.data.value, value);
  return change.id;
}
async function removeResource(path) {
  const removed = await gateway(path, 'DELETE');
  assert.ok([200, 204, 404].includes(removed.status), `Delete ${path}: ${removed.status}`);
  assert.equal((await gateway(path)).status, 404);
  owned.delete(path);
  report.cleanup.push(path + ' absent');
}
async function scenario(mode) {
  const passive = mode !== 'active';
  const mismatch = mode === 'passive-mismatch';
  const id = run + '-' + mode;
  const uri = '/__service_health/' + id;
  const a = backends['node-a'],
    b = backends['node-b'];
  const active = {
    type: 'http',
    http_path: '/ready-' + mode,
    ...(algorithm === 'chash' ? { host: 'probe.example.test', port: 80 } : {}),
    req_headers: ['X-Service-Health-Probe: apisix'],
    timeout: 1,
    concurrency: 2,
    healthy: { interval: 1, successes: 2, http_statuses: [200] },
    unhealthy: {
      interval: passive ? 5 : 1,
      timeouts: 2,
      tcp_failures: 2,
      http_failures: 2,
      http_statuses: [503],
    },
  };
  const checks = { active };
  if (passive)
    checks.passive = {
      type: 'http',
      healthy: { successes: 2, http_statuses: [200] },
      unhealthy: { http_failures: 2, tcp_failures: 2, timeouts: 2, http_statuses: [503] },
    };
  const result = (report.scenarios[mode] = { id, uri, checks, states: [], traffic: {} });
  const upstream = {
    type: algorithm,
    ...(algorithm === 'chash' ? { hash_on: 'header', key: 'x-health-test-shard' } : {}),
    retries: 0,
    timeout: { connect: 1, send: 1, read: 1 },
    nodes: { [a.ip + ':80']: 1, [b.ip + ':80']: 1 },
    checks,
  };
  result.serviceChange = await publish('services', id, { name: id, upstream });
  result.routeChange = await publish('routes', id, {
    name: id,
    uri,
    service_id: id,
    methods: ['GET'],
    plugins: { 'response-rewrite': { headers: { set: { 'X-Health-Test-Worker': '$pid' } } } },
  });
  const storedRoute = (await gateway('/routes/' + id)).data.value;
  assert.ok(!('upstream' in storedRoute || 'upstream_id' in storedRoute));
  let sequence = 0;
  async function hit(close = false) {
    const headers = close ? { Connection: 'close' } : {};
    if (algorithm === 'chash') headers['x-health-test-shard'] = 'client-' + sequence++;
    const res = await sandboxProxy(uri, { headers });
    const node = res.headers.get('x-test-node');
    const body = await res.text();
    const worker = res.headers.get('x-health-test-worker');
    if (node) {
      assert.equal(body, node);
      assert.match(worker || '', /^\d+$/, 'Missing APISIX worker PID');
    }
    return { status: res.status, node, worker };
  }
  async function probeLog() {
    const log = await docker('logs', b.id);
    return log
      .split(/\r?\n/)
      .filter((line) => line.includes(' ' + active.http_path + ' ') && line.endsWith(' apisix'));
  }
  async function sample(label, expectedB) {
    const rows = (result.traffic[label] = []);
    for (let n = 0; n < 40; n++) {
      rows.push(await hit(label === 'newConnections'));
      if (!expectedB && n < 39) await sleep(50);
    }
    const countB = rows.filter((r) => r.node === 'node-b').length;
    if (expectedB) {
      assert.ok(
        rows.every((r) => r.status === 200 && ['node-a', 'node-b'].includes(r.node)),
        label + ': unexpected response',
      );
      assert.ok(countB > 0 && countB < rows.length, label + ': incorrect distribution');
    } else {
      // Record every exception and finish the recovery experiment even if an isolated request leaks.
      const exceptions = rows.filter((r) => r.status !== 200 || r.node !== 'node-a');
      if (exceptions.length) report.failoverExceptions.push({ mode, label, exceptions });
    }
    console.log(
      mode,
      label,
      'A=' + rows.filter((r) => r.node === 'node-a').length,
      'B=' + countB,
      'HTTP 200=' + rows.filter((r) => r.status === 200).length,
    );
  }
  async function waitState(label, wantB) {
    const start = Date.now();
    let last;
    while (Date.now() - start < 30000) {
      const response = await getInside('127.0.0.1', 9090, '/v1/healthcheck/services/' + id);
      assert.equal(response.status, 200, response.body);
      const info = JSON.parse(response.body);
      assert.ok(info.name.endsWith('/services/' + id), info.name);
      last = info.nodes;
      result.states.push({ at: new Date().toISOString(), label, nodes: last });
      const nodeB = last?.find((n) => n.ip === b.ip && n.port === 80);
      if (
        last?.length === 2 &&
        last.find((n) => n.ip === a.ip && n.port === 80)?.status === 'healthy' &&
        nodeB?.status === wantB
      )
        return nodeB;
      await sleep(200);
    }
    throw new Error(label + ': timed out ' + JSON.stringify(last));
  }
  // First use starts the service checker. Allow the route to propagate before measurement.
  let warm;
  for (let i = 0; i < 40; i++) {
    warm = await hit();
    if (warm.status === 200 && warm.node) break;
    await sleep(250);
  }
  assert.equal(warm.status, 200);
  await waitState('before', 'healthy');
  await sample('before', true);
  if (passive) {
    await docker('exec', b.id, 'touch', '/tmp/service-health-fault');
    assert.equal((await getInside(b.ip, 80, '/check-business')).status, 503);
    assert.equal((await getInside(b.ip, 80, active.http_path)).status, 200);
    await sleep(2100);
    await waitState('fault before proxy traffic', 'healthy');
  } else {
    await docker('pause', b.id);
    paused = true;
    assert.equal(await docker('inspect', '-f', '{{.State.Paused}}', b.id), 'true');
  }
  const started = Date.now();
  if (passive) {
    const triggering = (result.traffic.trigger = []);
    let failures = 0;
    while (failures < 2 && triggering.length < 40) {
      const row = await hit();
      triggering.push(row);
      if (row.node === 'node-b' && row.status === 503) failures++;
      else assert.ok(row.node === 'node-a' && row.status === 200);
    }
    assert.equal(failures, 2, 'Expected two real HTTP 503 responses from B');
  }
  const removed = await waitState('removed', 'unhealthy');
  result.removalObservedMs = Date.now() - started;
  assert.ok(removed.counter[passive ? 'http_failure' : 'timeout_failure'] >= 2);
  if (mode === 'passive') await docker('exec', b.id, 'touch', '/tmp/readiness-unavailable');
  await sample('removed', false);
  if (!mismatch) {
    // Measure resuming an idle client and rotating connections as separate cohorts.
    const idleStart = Date.now();
    let failedProbes = 0;
    while (
      mode === 'passive' &&
      (failedProbes < 2 || Date.now() - idleStart < 7000) &&
      Date.now() - idleStart < 25000
    ) {
      failedProbes = (await probeLog()).filter((line) => line.endsWith(' 503 apisix')).length;
      await sleep(400);
    }
    if (!passive) await sleep(7100);
    result.idleMs = Date.now() - idleStart;
    if (passive)
      assert.ok(failedProbes >= 2, 'Expected active probes to confirm the continuing outage');
    await waitState('before resuming idle traffic', 'unhealthy');
    await sample('afterIdle', false);
    await waitState('before rotating connections', 'unhealthy');
    await sample('newConnections', false);
    const before = new Set(result.traffic.before.map((row) => row.worker));
    result.newWorkersDuringFault = [
      ...new Set(result.traffic.newConnections.map((row) => row.worker)),
    ].filter((pid) => pid && !before.has(pid));
    assert.ok(
      result.newWorkersDuringFault.length,
      'Cold-worker regression requires multiple gateway workers',
    );
  }
  if (mismatch) {
    const early = await waitState('readmitted before business recovery', 'healthy');
    assert.ok(early.counter.success >= 2);
    const rows = (result.traffic.prematureReadmission = []);
    for (let i = 0; i < 40; i++) {
      const row = await hit();
      rows.push(row);
      if (row.node === 'node-b') break;
      assert.ok(row.node === 'node-a' && row.status === 200);
    }
    assert.partialDeepStrictEqual(rows.at(-1), { node: 'node-b', status: 503 });
    console.log(mode, 'B received proxy traffic and returned 503 before business recovery');
  } else await waitState('after failover traffic', 'unhealthy');
  if (passive) {
    assert.equal((await getInside(b.ip, 80, active.http_path)).status, mismatch ? 200 : 503);
    assert.equal((await getInside(b.ip, 80, '/check-business')).status, 503);
    await docker('exec', b.id, 'unlink', '/tmp/service-health-fault');
    if (!mismatch) await docker('exec', b.id, 'unlink', '/tmp/readiness-unavailable');
  } else {
    await docker('unpause', b.id);
    paused = false;
  }
  if (!mismatch) {
    const restored = Date.now();
    // No proxy traffic during readmission. Only APISIX's own active probes can recover B.
    const recovered = await waitState('recovered', 'healthy');
    result.recoveryObservedMs = Date.now() - restored;
    assert.ok(recovered.counter.success >= 2);
  }
  await sample('recovered', true);
  result.probesOnB = await probeLog();
  assert.ok(result.probesOnB.filter((line) => line.endsWith(' 200 apisix')).length >= 2);
  if (mismatch) assert.ok(result.probesOnB.every((line) => line.endsWith(' 200 apisix')));
  if (!mismatch)
    console.log(
      mode,
      'observed removal/recovery (ms)',
      result.removalObservedMs,
      result.recoveryObservedMs,
    );
  for (const kind of ['routes', 'services']) await removeResource('/' + kind + '/' + id);
}
try {
  for (const name of ['node-a', 'node-b']) await startBackend(name);
  report.nodes = Object.fromEntries(Object.entries(backends).map(([name, v]) => [name, v.ip]));
  assert.notEqual(report.nodes['node-a'], report.nodes['node-b']);
  for (const mode of ['active', 'passive', 'passive-mismatch']) await scenario(mode);
  report.passed = report.failoverExceptions.length === 0;
  if (!report.passed) {
    console.error('Failover exceptions:', JSON.stringify(report.failoverExceptions));
    process.exitCode = 1;
  }
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  const cleanup = async (fn) => {
    try {
      await fn();
    } catch (error) {
      report.passed = false;
      process.exitCode = 1;
      report.cleanup.push(error.message);
      console.error(error.message);
    }
  };
  if (paused) await cleanup(() => docker('unpause', backends['node-b'].id));
  for (const path of [...owned].reverse()) await cleanup(() => removeResource(path));
  for (const { id } of Object.values(backends))
    await cleanup(async () => {
      await docker('rm', '-fv', id);
      assert.equal(await docker('ps', '-aq', '--filter', 'id=' + id), '');
      report.cleanup.push('Removed test container ' + id.slice(0, 12));
    });
  await mkdir(evidenceDir, { recursive: true });
  const file = new URL(run + '.json', evidenceDir);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence:', fileURLToPath(file));
}

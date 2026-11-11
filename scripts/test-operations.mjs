import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sandboxClient } from './sandbox-client.mjs';

const { request, gateway, waitChange } = await sandboxClient();
const clusters = await request('/clusters');
const dev = clusters.find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
const stage = clusters.find(
  (c) => c.url === 'http://apisix-staging:9180/apisix/admin' && c.environment === 'staging',
);
assert.ok(dev && stage && !dev.read_only && !stage.read_only, 'Dedicated local sandboxes required');
const uid = 'p1-' + Date.now(),
  path = '/' + uid,
  secret = randomBytes(24).toString('hex');
const secondaryKey = randomBytes(24).toString('hex');
const local = (c, k, id) =>
  '/clusters/' + c.id + '/resources/' + k + (id ? '/' + encodeURIComponent(id) : '');
const resource = (c, k, id) => request(local(c, k, id));
const draftIds = [],
  devCreated = [],
  stagedChanges = [],
  createdChanges = [];
let passed = 0;
const pass = (s) => console.log('PASS', ++passed, s);
const reject = (p, code) => assert.rejects(p, (e) => e.status === code);
const createDraft = async (c, k, id, value) => {
  const d = await request('/drafts', 'POST', {
    cluster_id: c.id,
    resource_type: k,
    resource_id: id,
    action: 'create',
    value,
  });
  draftIds.push(d.id);
  return d;
};
async function change(ids) {
  const ch = await request('/changesets', 'POST', {
    draft_ids: ids,
    title: uid,
    reason: 'P1 local integration verification',
  });
  createdChanges.push(ch.id);
  return ch;
}
async function publish(ch) {
  const validation = await request('/changesets/' + ch.id + '/validate', 'POST', {});
  assert.ok(validation.ok, JSON.stringify(validation.checks.filter((x) => !x.ok)));
  await request('/changesets/' + ch.id + '/publish', 'POST', {});
  const done = await waitChange(ch.id);
  assert.equal(
    done.status,
    'succeeded',
    JSON.stringify(done.operations.map((o) => [o.resource_type, o.status, o.error])),
  );
  return done;
}
const rollback = async (ch) =>
  publish(await request('/changesets/' + ch.id + '/rollback', 'POST', {}));
async function proxy(port, headers = {}, expected = 200) {
  let status;
  for (let i = 0; i < 30; i++) {
    const res = await fetch('http://127.0.0.1:' + port + path, { headers });
    status = res.status;
    if (status === expected) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Expected ' + expected + ', got ' + status + ' on ' + port);
}
const ssl = execFileSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'apisix',
    'sh',
    '-ec',
    'd=$(mktemp -d); trap \'rm -f "$d/key" "$d/cert"; rmdir "$d"\' EXIT; openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=p1.example.invalid -keyout "$d/key" -out "$d/cert" 2>/dev/null; cat "$d/cert" "$d/key"',
  ],
  { encoding: 'utf8' },
);
const cert = ssl.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0],
  key = ssl.match(/-----BEGIN [^\n]*PRIVATE KEY-----[\s\S]*?-----END [^\n]*PRIVATE KEY-----/)[0];
const metadataCandidates = ['file-logger', 'http-logger', 'tcp-logger'];
let meta;
for (const name of metadataCandidates)
  if ((await gateway('/plugin_metadata/' + name)).status === 404) {
    meta = name;
    break;
  }
assert.ok(meta, 'Requires an unused local metadata fixture');
const fixtures = [
  ['upstreams', uid, { name: uid, type: 'roundrobin', nodes: { 'echo:80': 1 } }],
  [
    'protos',
    uid,
    { content: 'syntax = "proto3"; package check; message Ping { string text = 1; }' },
  ],
  ['secrets', 'vault:' + uid, { uri: 'http://vault.invalid', prefix: '/kv', token: secret }],
  ['secrets', 'aws:' + uid, { access_key_id: uid, secret_access_key: secret, region: 'us-east-1' }],
  ['secrets', 'gcp:' + uid, { auth_file: '/tmp/' + uid + '.json', ssl_verify: true }],
  ['credentials', uid + ':secondary', { plugins: { 'key-auth': { key: secondaryKey } } }],
  ['plugin_metadata', meta, { log_format: { route: '$route_id' } }],
  ['consumer_groups', uid, { plugins: {} }],
  [
    'global_rules',
    uid,
    {
      plugins: {
        'response-rewrite': {
          headers: { set: { 'X-P1-Global': 'ok' } },
          _meta: { filter: [['uri', '==', path]] },
        },
      },
    },
  ],
  ['services', uid, { upstream_id: uid }],
  ['plugin_configs', uid, { plugins: { 'key-auth': {} } }],
  ['consumers', uid, { username: uid, group_id: uid }],
  [
    'plugin_configs',
    uid + '-sensitive',
    {
      desc: 'source policy',
      plugins: { 'proxy-rewrite': { headers: { set: { 'X-Test-Token': secret } } } },
    },
  ],
  ['credentials', uid + ':primary', { plugins: { 'key-auth': { key: secret } } }],
  ['routes', uid, { uri: path, service_id: uid, plugin_config_id: uid }],
];
const gatewayPath = (k, id) =>
  k === 'credentials'
    ? '/consumers/' + id.replace(':', '/credentials/')
    : k === 'secrets'
      ? '/secrets/' + id.replace(':', '/')
      : '/' + k + '/' + id;
try {
  assert.equal((await gateway('/ssls/' + uid)).status, 404);
  assert.ok(
    [200, 201].includes(
      (
        await gateway('/ssls/' + uid, 'PUT', {
          type: 'server',
          status: 1,
          snis: [uid + '.example.invalid'],
          cert,
          key,
        })
      ).status,
    ),
  );
  const sslRead = await resource(dev, 'ssls', uid);
  assert.ok(sslRead.value.cert);
  assert.equal(sslRead.value.key, undefined);
  await reject(createDraft(dev, 'ssls', uid + '-new', { cert, key }), 400);
  pass('TLS inventory supports target references and prevents irrecoverable private-key changes');
  for (const [k, id, v] of fixtures) {
    const gp = gatewayPath(k, id);
    assert.equal((await gateway(gp)).status, 404);
    const d = await createDraft(dev, k, id, v);
    assert.ok(!JSON.stringify(d).includes(secret));
    assert.ok(!JSON.stringify(d).includes('BEGIN PRIVATE KEY'));
    devCreated.push([k, id, d.id]);
  }
  const src = await publish(await change([...devCreated].reverse().map((d) => d[2])));
  pass(devCreated.length + ' resource drafts, dependency-ordered publish and readback');
  await proxy(19080, {}, 401);
  assert.equal((await proxy(19080, { apikey: secret })).headers.get('x-p1-global'), 'ok');
  await proxy(19080, { apikey: secondaryKey });
  pass('two independent API keys, shared authentication, global rule and service forwarding');
  for (const [k, id] of devCreated) {
    const item = await resource(dev, k, id);
    assert.ok(!JSON.stringify(item).includes(secret));
    assert.ok(!JSON.stringify(item).includes('BEGIN PRIVATE KEY'));
    const list = await request(local(dev, k) + (k === 'credentials' ? '?owner=' + uid : ''));
    assert.ok(
      list.items.some((v) => v.id === id),
      k + ' missing in list',
    );
  }
  pass('collection and individual reads for all 11 writable resource kinds, redaction');
  assert.ok(
    (await request(local(dev, 'plugin_configs', uid) + '/impact')).references.some(
      (r) => r.id === uid && r.kind === 'routes',
    ),
  );
  assert.ok(
    (await request(local(dev, 'services', uid) + '/impact')).dependencies.some(
      (r) => r.kind === 'upstreams' && r.id === uid,
    ),
  );
  pass('forward dependencies and reverse impact');
  const bundle = await request('/clusters/' + dev.id + '/export', 'POST', {
    roots: [{ kind: 'routes', id: uid }],
  });
  assert.deepEqual(bundle.items.map((i) => i.kind).sort(), [
    'plugin_configs',
    'routes',
    'services',
    'upstreams',
  ]);
  pass('recursive export deduplicates shared dependencies');
  const target = uid + '-stage';
  const options = {
    bundle,
    ids: Object.fromEntries(bundle.items.map((i) => [i.kind + '/' + uid, target])),
    nodes: { 'echo:80': 'echo-staging:80' },
  };
  const transfer = (step, body) =>
    request('/clusters/' + stage.id + '/transfer/' + step, 'POST', body);
  const preview = await transfer('preview', options);
  assert.ok(preview.ready);
  assert.ok(preview.rows.every((v) => v.action === 'create'));
  await reject(transfer('stage', { ...options, token: 'expired' }), 409);
  const dup = await createDraft(stage, 'services', target, { upstream_id: target });
  await reject(transfer('stage', { ...options, token: preview.token }), 409);
  const active = (await request('/drafts?cluster_id=' + stage.id)).filter(
    (v) => v.status === 'draft' && v.resource_id === target,
  );
  assert.deepEqual(
    active.map((d) => d.id),
    [dup.id],
  );
  await request('/drafts/' + dup.id, 'DELETE');
  pass('stale preview blocked and draft conflicts roll back entire batch');
  const saved = await transfer('stage', { ...options, token: preview.token });
  draftIds.push(...saved.draft_ids);
  const stageKey = randomBytes(24).toString('hex');
  const stageCaller = await createDraft(stage, 'consumers', uid, {
    username: uid,
    plugins: { 'key-auth': { key: stageKey } },
  });
  const stagePolicy = await createDraft(stage, 'plugin_configs', uid + '-sensitive', {
    desc: 'target policy',
    plugins: { 'proxy-rewrite': { headers: { set: { 'X-Test-Token': stageKey } } } },
  });
  const targetChange = await publish(
    await change([...saved.draft_ids, stageCaller.id, stagePolicy.id]),
  );
  stagedChanges.push(targetChange);
  assert.equal((await resource(stage, 'routes', target)).value.service_id, target);
  assert.ok((await resource(stage, 'upstreams', target)).value.nodes['echo-staging:80']);
  await proxy(29080, {}, 401);
  await proxy(29080, { apikey: secret }, 401);
  assert.equal((await (await proxy(29080, { apikey: stageKey })).json()).service, 'echo-staging');
  pass('real dev-to-staging migration, mapped references and nodes, isolated credentials');
  const protectedBundle = await request('/clusters/' + dev.id + '/export', 'POST', {
    roots: [{ kind: 'plugin_configs', id: uid + '-sensitive' }],
  });
  assert.ok(!JSON.stringify(protectedBundle).includes(secret));
  assert.equal(
    protectedBundle.items[0].value.plugins['proxy-rewrite'].headers.set['X-Test-Token'],
    '${dashboard:keep-secret}',
  );
  const retained = {
    bundle: protectedBundle,
    strategies: { ['plugin_configs/' + uid + '-sensitive']: 'overwrite' },
  };
  const retainedPreview = await transfer('preview', retained);
  assert.ok(retainedPreview.ready);
  assert.ok(!JSON.stringify(retainedPreview).includes(stageKey));
  assert.deepEqual(
    retainedPreview.rows[0].diff.map((d) => d.path),
    ['/desc'],
  );
  const retainedBatch = await transfer('stage', { ...retained, token: retainedPreview.token });
  draftIds.push(...retainedBatch.draft_ids);
  const retainedChange = await publish(await change(retainedBatch.draft_ids));
  stagedChanges.push(retainedChange);
  await rollback(retainedChange);
  stagedChanges.pop();
  pass('redacted export retains the target secret through update and rollback');
  const changed = structuredClone(options);
  changed.bundle.items.find((i) => i.kind === 'routes').value.desc = 'changed';
  const conflict = await transfer('preview', changed);
  assert.equal(conflict.ready, false);
  assert.ok(conflict.rows.some((r) => r.action === 'conflict'));
  changed.strategies = { ['routes/' + uid]: 'reuse' };
  assert.ok((await transfer('preview', changed)).rows.some((r) => r.action === 'reuse'));
  changed.strategies = { ['routes/' + uid]: 'overwrite' };
  const overwrite = await transfer('preview', changed);
  assert.ok(overwrite.ready);
  assert.ok(overwrite.rows.some((r) => r.action === 'update' && r.diff.length));
  pass('ID collision, explicit reuse and field-level overwrite preview');
  const prior = await resource(stage, 'routes', target);
  const drift = await request('/drafts', 'POST', {
    cluster_id: stage.id,
    resource_type: 'routes',
    resource_id: target,
    action: 'update',
    base_hash: prior.hash,
    value: { ...prior.value, desc: 'concurrent target update' },
  });
  draftIds.push(drift.id);
  const concurrent = await publish(await change([drift.id]));
  stagedChanges.push(concurrent);
  await reject(transfer('stage', { ...changed, token: overwrite.token }), 409);
  await rollback(concurrent);
  stagedChanges.pop();
  pass('an actual concurrent target release invalidates the previous migration preview');
  await reject(
    request('/clusters/' + dev.id + '/export', 'POST', {
      roots: [{ kind: 'credentials', id: uid + ':primary' }],
    }),
    422,
  );
  const bad = {
    format: bundle.format,
    items: [
      { kind: 'routes', id: uid + '-bad', value: { uri: path, upstream_id: 'missing-' + uid } },
    ],
  };
  await reject(transfer('preview', { bundle: bad }), 422);
  const sensitive = {
    format: bundle.format,
    items: [
      {
        kind: 'plugin_configs',
        id: uid + '-bad',
        value: { plugins: { 'proxy-rewrite': { headers: { set: { Authorization: secret } } } } },
      },
    ],
  };
  await reject(transfer('preview', { bundle: sensitive }), 422);
  pass('unresolved references, plaintext protected fields and credential exports rejected');
  const noStream = await request(local(dev, 'stream_routes')).then(
    () => false,
    (e) => e.message.includes('Stream'),
  );
  assert.ok(noStream);
  pass('disabled stream capability is reported by the HTTP-only sandbox');
  const sameName = {
    format: bundle.format,
    items: [
      {
        kind: 'upstreams',
        id: uid + '-other',
        value: { name: uid, nodes: { 'echo-staging:80': 1 } },
      },
    ],
  };
  const collision = await transfer('preview', { bundle: sameName });
  assert.equal(collision.ready, false);
  assert.deepEqual(collision.rows[0].namesakes, [target]);
  assert.ok(
    (
      await transfer('preview', {
        bundle: sameName,
        strategies: { ['upstreams/' + uid + '-other']: 'create' },
      })
    ).ready,
  );
  pass('same display name on a different ID requires an explicit choice');
  const refBundle = {
    format: bundle.format,
    items: [
      {
        kind: 'plugin_configs',
        id: uid + '-ref',
        value: {
          plugins: {
            'proxy-rewrite': {
              headers: { set: { Authorization: '$secret://vault/' + uid + '/auth' } },
            },
          },
        },
      },
    ],
  };
  await reject(transfer('preview', { bundle: refBundle }), 422);
  pass('missing target-side Secret provider reference blocks staging');
  await rollback(targetChange);
  stagedChanges.pop();
  await proxy(29080, {}, 404);
  await rollback(src);
  await proxy(19080, {}, 404);
  pass('both environments roll back and temporary proxy routes disappear');
} finally {
  await gateway('/ssls/' + uid, 'DELETE');
  for (const ch of stagedChanges.reverse()) await rollback(ch);
  for (const [k, id] of devCreated
    .reverse()
    .sort(([a], [b]) => Number(b === 'credentials') - Number(a === 'credentials'))) {
    const p = gatewayPath(k, id);
    if ((await gateway(p)).status === 200) {
      assert.ok(id.includes(uid) || (k === 'plugin_metadata' && id === meta));
      assert.ok([200, 404].includes((await gateway(p, 'DELETE')).status));
    }
  }
  for (const id of createdChanges) {
    const ch = await request('/changesets/' + id);
    if (ch.status === 'pending') await request('/changesets/' + id + '/cancel', 'POST', {});
  }
  for (const id of draftIds)
    await request('/drafts/' + id, 'DELETE').catch((e) => {
      if (e.status !== 409) throw e;
    });
}
console.log('Operations integration passed:', passed);

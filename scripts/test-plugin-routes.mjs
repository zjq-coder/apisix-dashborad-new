import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import http from 'node:http';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';
import { routeCases } from './plugin-route-cases.mjs';
import { consumerAuthFixtures } from './consumer-auth-fixtures.mjs';

const run = 'plug-' + randomUUID().slice(0, 8);
const host = run + '.example.test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = async (...args) =>
  (await promisify(execFile)('docker', args, { windowsHide: true })).stdout.trim();
const { request, gateway, waitChange } = await sandboxClient();
const cluster = (await request('/clusters')).find(
  (c) => c.environment === 'development' && c.url === 'http://apisix:9180/apisix/admin',
);
assert.ok(cluster && !cluster.read_only);
const base = '/clusters/' + cluster.id;
const source = (await gateway('/routes/sandbox-orders-api')).data.value;
assert.equal(source.uri, '/api/orders/*');
assert.ok(source.upstream_id);
const original = async () => (await request(base + '/resources/routes/sandbox-orders-api')).hash;
const beforeHash = await original();
const dir = '.local/plugins-audit';
await mkdir(dir, { recursive: true });
const manifest = JSON.parse(await readFile('web/src/data/plugin-hub.json', 'utf8'));
const docs = manifest.flatMap((g) => Object.keys(g.plugins));
const wanted = new Set(process.argv.slice(2));
const catalog = await request(base + '/plugins/catalog');
const gw = await docker('compose', 'ps', '-q', 'apisix');
assert.ok(gw);
const network = Object.keys(
  JSON.parse(await docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', gw)),
)[0];
const rows = {},
  routes = new Set(),
  logPaths = new Set();
let ownsProto = false;
const report = {
  run,
  orderRoute: 'sandbox-orders-api',
  upstream: source.upstream_id,
  started: new Date().toISOString(),
  enabled: catalog.length,
  official: docs.length,
  rows,
  cleanup: false,
};
const completionKey = randomBytes(24).toString('hex');
let fixture;
let broker, redis, tlsVolume;
let auth,
  ownsConsumer = false;
const consumerId = run + '-consumer';
try {
  const tlsMount = [];
  if (!wanted.size || wanted.has('sls-logger') || wanted.has('saml-auth')) {
    tlsVolume = await docker('volume', 'create', run + '-tls');
    await docker(
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      tlsVolume + ':/tls',
      'golang:1.27.3-bookworm',
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      '/tls/key',
      '-out',
      '/tls/cert',
      '-days',
      '1',
      '-subj',
      '/CN=plugin-peer',
    );
    tlsMount.push('-v', tlsVolume + ':/tls:ro');
  }
  fixture = await docker(
    'run',
    '-d',
    '--rm',
    '--network',
    network,
    '-p',
    '127.0.0.1::8080',
    ...tlsMount,
    '-v',
    fileURLToPath(new URL('./fixtures/plugin-peer.mjs', import.meta.url)) + ':/peer.mjs:ro',
    'node:24-bookworm-slim',
    'node',
    '/peer.mjs',
  );
  const ip = await docker(
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    fixture,
  );
  const port = (await docker('port', fixture, '8080/tcp')).split(':').pop();
  const peer = 'http://' + ip + ':8080',
    local = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 30; i++) {
    if (
      await fetch(local + '/__ready')
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await sleep(100);
  }
  assert.equal((await fetch(local + '/__ready')).status, 200);
  const brokerName = run + '-broker';
  if (!wanted.size || wanted.has('ai-cache'))
    redis = await docker(
      'run',
      '-d',
      '--rm',
      '--name',
      run + '-redis',
      '--network',
      network,
      'redis:6.2.16-alpine',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    );
  if (!wanted.size || wanted.has('kafka-logger') || wanted.has('kafka-proxy')) {
    const env = {
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,AUTH://:9094',
      KAFKA_ADVERTISED_LISTENERS:
        'PLAINTEXT://' + brokerName + ':9092,AUTH://' + brokerName + ':9094',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,AUTH:SASL_PLAINTEXT',
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_LISTENER_NAME_AUTH_PLAIN_SASL_JAAS_CONFIG:
        'org.apache.kafka.common.security.plain.PlainLoginModule required user_orders="' +
        completionKey +
        '";',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    };
    broker = await docker(
      'run',
      '-d',
      '--rm',
      '--name',
      brokerName,
      '--network',
      network,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', k + '=' + v]),
      'apache/kafka:3.9.1',
    );
    await docker(
      'exec',
      broker,
      '/opt/kafka/bin/kafka-topics.sh',
      '--bootstrap-server',
      'localhost:9092',
      '--create',
      '--topic',
      run,
      '--partitions',
      '1',
      '--replication-factor',
      '1',
    );
    await docker(
      'exec',
      broker,
      '/opt/kafka/bin/kafka-topics.sh',
      '--bootstrap-server',
      'localhost:9092',
      '--create',
      '--topic',
      run + '-proxy',
      '--partitions',
      '1',
      '--replication-factor',
      '1',
    );
    await docker(
      'exec',
      broker,
      'sh',
      '-ec',
      'echo order | /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic "$1"',
      'seed',
      run + '-proxy',
    );
  }
  if (!wanted.size || wanted.has('grpc-transcode')) {
    assert.equal((await gateway('/protos/' + run)).status, 404);
    ownsProto = true;
    const change = await request(base + '/config/apply', 'POST', {
      resource_type: 'protos',
      resource_id: run,
      action: 'create',
      value: {
        content:
          'syntax = "proto3"; package orders; message Order { string id = 1; } service Lookup { rpc Get(Order) returns (Order); }',
      },
    });
    assert.equal((await waitChange(change.id)).status, 'succeeded');
  }
  const names = [
    ...new Set([
      ...docs.flatMap((n) =>
        n === 'serverless' ? ['serverless-pre-function', 'serverless-post-function'] : [n],
      ),
      ...catalog.map((x) => x.name),
    ]),
  ];
  const saml = tlsVolume
    ? {
        cert: await docker('exec', fixture, 'cat', '/tls/cert'),
        key: await docker('exec', fixture, 'cat', '/tls/key'),
      }
    : {};
  const authNames = catalog.filter((x) => x.consumer_source !== 'none').map((x) => x.name);
  if (
    !wanted.size ||
    [...wanted].some((n) =>
      [...authNames, 'acl', 'attach-consumer-label', 'multi-auth', 'consumer-restriction'].includes(
        n,
      ),
    )
  ) {
    auth = await consumerAuthFixtures('auth-' + run);
    assert.equal((await gateway('/consumers/' + consumerId)).status, 404);
    ownsConsumer = true;
    const change = await request(base + '/config/apply', 'POST', {
      resource_type: 'consumers',
      resource_id: consumerId,
      action: 'create',
      value: { username: consumerId, labels: { team: 'orders' }, plugins: auth.credentials },
    });
    assert.equal((await waitChange(change.id)).status, 'succeeded');
  }
  for (const name of names) {
    if (wanted.size && !wanted.has(name)) continue;
    const entry = (rows[name] = {
      official: docs.includes(name) || name.startsWith('serverless-'),
      enabled: catalog.some((x) => x.name === name),
    });
    if (!entry.enabled) {
      entry.result = 'not-enabled';
      continue;
    }
    const path = '/api/orders/' + run + '/' + name,
      id = run + '-' + name,
      marker = run + '-' + name;
    const log = '/tmp/' + marker + '.log';
    const cases = routeCases({
      peer,
      ip,
      path,
      marker,
      completionKey,
      protoId: run,
      brokerName,
      redisHost: run + '-redis',
      saml,
      streamBody: async (observe) => {
        let req;
        const finished = new Promise((resolve, reject) => {
          req = http.request(
            'http://127.0.0.1:19080' + path,
            { method: 'POST', headers: { host, 'content-length': 8 } },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            },
          );
          req.on('error', reject);
          req.write('part');
        });
        try {
          await observe();
        } finally {
          req.end('end!');
        }
        assert.equal(await finished, 200);
      },
      signingKey:
        name === 'google-cloud-logging'
          ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
              type: 'pkcs8',
              format: 'pem',
            })
          : '',
      consume: () =>
        docker(
          'exec',
          broker,
          '/opt/kafka/bin/kafka-console-consumer.sh',
          '--bootstrap-server',
          'localhost:9092',
          '--topic',
          run,
          '--from-beginning',
          '--max-messages',
          '1',
          '--timeout-ms',
          '15000',
        ),
      metrics: async (id) => {
        for (let i = 0; i < 45; i++) {
          const data = await docker(
            'exec',
            gw,
            'bash',
            '-ec',
            'exec 3<>/dev/tcp/127.0.0.1/9091; printf "GET /apisix/prometheus/metrics HTTP/1.0\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" >&3; cat <&3',
          );
          if (
            data
              .split('\n')
              .some(
                (line) =>
                  line.startsWith('apisix_http_status{') &&
                  line.includes('route="' + id + '"') &&
                  line.includes('code="200"'),
              )
          )
            return;
          await sleep(1000);
        }
        throw new Error('missing route status metric');
      },
      events: async (predicate) => {
        // Zipkin starts flushing after five idle seconds; its timer and receiver run asynchronously.
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const data = await (await fetch(local + '/__events')).json();
          if (data.some(predicate)) return;
          await sleep(250);
        }
        throw new Error('Expected delivery not seen on the protocol peer');
      },
      inspectLog: async (needle) => {
        logPaths.add(log);
        const text = await docker('exec', gw, 'cat', log);
        assert.ok(text.includes(needle));
        return JSON.parse(text.split('\n').at(-1));
      },
    });
    if (auth) {
      for (const credential of authNames)
        cases[credential] = {
          config: auth.routes[credential],
          effect: '订单路由拒绝缺失和无效凭据，正确消费者可访问原订单上游',
          test: async (hit) => {
            assert.equal((await hit()).status, credential === 'jwe-decrypt' ? 403 : 401);
            assert.equal(
              (await hit({ headers: auth.headers(credential, undefined, true) })).status,
              credential === 'jwe-decrypt' ? 400 : credential === 'wolf-rbac' ? 403 : 401,
            );
            const r = await hit({ headers: auth.headers(credential) });
            assert.equal(r.status, 200);
            assert.equal((await r.json()).service, 'dashboard-sandbox');
          },
        };
      cases['multi-auth'] = {
        config: { auth_plugins: [{ 'key-auth': {} }, { 'basic-auth': {} }] },
        effect: '两种不同凭据均能访问订单，缺失凭据返回 401',
        test: async (hit) => {
          assert.equal((await hit()).status, 401);
          for (const n of ['key-auth', 'basic-auth'])
            assert.equal((await hit({ headers: auth.headers(n) })).status, 200);
        },
      };
      for (const [n, value] of Object.entries({
        acl: { deny_labels: { team: ['orders'] } },
        'consumer-restriction': { blacklist: [consumerId] },
        'attach-consumer-label': { headers: { 'X-Console-Set': '$team' } },
      })) {
        const label = n === 'attach-consumer-label';
        cases[n] = {
          config: value,
          plugins: {
            'key-auth': {},
            ...(label ? { 'proxy-rewrite': { uri: '/__inspect/labels' } } : {}),
          },
          effect: label
            ? '原订单上游收到已认证消费者的 team 标签'
            : '已知消费者命中拒绝规则返回 403',
          test: async (hit) => {
            const r = await hit({ headers: auth.headers('key-auth') });
            assert.equal(r.status, label ? 200 : 403);
            if (label) assert.ok((await r.text()).includes('set=orders'));
          },
        };
      }
    }
    try {
      const schema = await request(base + '/plugins/' + name + '/schema?scope=route');
      entry.fields = Object.keys(schema.properties || {}).filter((k) => k !== '_meta').length;
      const validate = (value) =>
        request(base + '/plugins/' + name + '/validate', 'POST', {
          resource_type: 'routes',
          value,
        });
      const test = cases[name];
      if (!test) {
        entry.result = 'schema-only';
        continue;
      }
      const config = test.config;
      await validate(config);
      await assert.rejects(
        validate({ ...config, _meta: { disable: 'invalid' } }),
        (e) => e.status === 422,
      );
      entry.validation = 'valid accepted, invalid rejected';
      const route = {
        name: id,
        uri: path + '*',
        host: test.host || host,
        priority: 100,
        status: test.test ? 1 : 0,
        methods: ['GET', 'POST', 'OPTIONS', 'PUT'],
        plugins: { ...test.plugins, [name]: config },
        ...(test.upstream ? { upstream: test.upstream } : { upstream_id: source.upstream_id }),
      };
      assert.equal((await gateway('/routes/' + id)).status, 404);
      routes.add(id);
      const change = await request(base + '/config/apply', 'POST', {
        resource_type: 'routes',
        resource_id: id,
        action: 'create',
        value: route,
      });
      const final = await waitChange(change.id);
      assert.equal(final.status, 'succeeded', final.operations?.map((o) => o.error).join(';'));
      const stored = await gateway('/routes/' + id);
      assert.equal(stored.status, 200);
      try {
        assert.partialDeepStrictEqual(stored.data.value.plugins[name], config);
      } catch {
        throw new Error('Gateway readback differs from submitted configuration');
      }
      entry.published = true;
      entry.limitation = test.limitation;
      if (!test.test) {
        entry.result = 'config-verified';
        continue;
      }
      const statuses = [];
      const hit = async (options = {}) => {
        const response = await sandboxProxy(path + (options.suffix || ''), {
          ...options,
          headers: { host, ...options.headers },
        });
        statuses.push(response.status);
        return response;
      };
      entry.statuses = statuses;
      await sleep(200);
      await test.test(hit);
      entry.result = 'effect-verified';
      entry.effect = test.effect;
    } catch (error) {
      entry.result = 'failed';
      entry.error = error.message.slice(0, 450);
      process.exitCode = 1;
    }
    console.log(name, entry.result, entry.error || '');
  }
} finally {
  const cleanupErrors = [];
  for (const id of routes) {
    const outcome = await gateway('/routes/' + id, 'DELETE').catch(() => ({ status: 0 }));
    if (
      ![200, 204, 404].includes(outcome.status) ||
      (await gateway('/routes/' + id)).status !== 404
    )
      cleanupErrors.push(id);
  }
  if (ownsProto) {
    await gateway('/protos/' + run, 'DELETE');
    if ((await gateway('/protos/' + run)).status !== 404) cleanupErrors.push('protos/' + run);
  }
  if (ownsConsumer) {
    await gateway('/consumers/' + consumerId, 'DELETE');
    if ((await gateway('/consumers/' + consumerId)).status !== 404)
      cleanupErrors.push('consumers/' + consumerId);
  }
  if (auth) await auth.cleanup();
  for (const log of logPaths) await docker('exec', gw, 'rm', '-f', log);
  if (fixture) await docker('stop', fixture);
  if (broker) await docker('stop', broker);
  if (redis) await docker('stop', redis);
  if (tlsVolume) await docker('volume', 'rm', tlsVolume);
  report.sourceUnchanged = (await original()) === beforeHash;
  report.cleanup = !cleanupErrors.length && report.sourceUnchanged;
  report.finished = new Date().toISOString();
  const file = dir + '/' + run + '.json';
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log(file, 'cleanup:', report.cleanup);
  assert.ok(report.cleanup);
}
for (const name of wanted) assert.ok(rows[name], 'Unknown plugin: ' + name);

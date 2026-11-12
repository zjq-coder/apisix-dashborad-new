// Plugins requiring node settings, shared metadata or Stream get a disposable APISIX and etcd.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliDecompressSync } from 'node:zlib';
import { stringify } from 'yaml';
import { sandboxClient } from './sandbox-client.mjs';

const docker = async (...args) =>
  (await promisify(execFile)('docker', args, { windowsHide: true })).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = 'optional-' + randomBytes(4).toString('hex'),
  adminKey = randomBytes(24).toString('hex');
const root = new URL('../.local/plugins-audit/' + run + '/', import.meta.url);
const report = { run, rows: {}, cleanup: false },
  containers = [];
async function start(args) {
  const id = await docker('run', '-d', '--rm', ...args);
  containers.push(id);
  return id;
}
async function until(check, timeout = 18000) {
  const end = Date.now() + timeout;
  let err;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch (e) {
      err = e;
    }
    await sleep(300);
  } while (Date.now() < end);
  throw err || new Error('Expected observation timed out');
}
const focused = new Set(process.argv.slice(2));
async function check(name, description, fn) {
  if (focused.size && !focused.has(name)) return;
  try {
    await fn();
    report.rows[name] = { result: 'effect-verified', effect: description };
  } catch (e) {
    report.rows[name] = { result: 'failed', error: e.message.slice(0, 320) };
    process.exitCode = 1;
  }
  console.log(name, report.rows[name]);
}
const { gateway } = await sandboxClient();
try {
  await mkdir(root, { recursive: true });
  const live = await docker('compose', 'ps', '-q', 'apisix'),
    image = await docker('inspect', '-f', '{{.Image}}', live);
  const network = Object.keys(
    JSON.parse(await docker('inspect', '-f', '{{json .NetworkSettings.Networks}}', live)),
  )[0];
  const etcdName = run + '-etcd';
  await start([
    '--name',
    etcdName,
    '--network',
    network,
    'quay.io/coreos/etcd:v3.5.21',
    '/usr/local/bin/etcd',
    '--listen-client-urls',
    'http://0.0.0.0:2379',
    '--advertise-client-urls',
    'http://' + etcdName + ':2379',
    '--data-dir',
    '/tmp/etcd',
  ]);
  const peer = await start([
    '--network',
    network,
    '-p',
    '127.0.0.1::8080',
    '-v',
    fileURLToPath(new URL('./fixtures/plugin-peer.mjs', import.meta.url)) + ':/peer.mjs:ro',
    'node:24-bookworm-slim',
    'node',
    '/peer.mjs',
  ]);
  const ip = await docker(
    'inspect',
    '-f',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    peer,
  );
  const events =
    'http://127.0.0.1:' + (await docker('port', peer, '8080')).split(':').pop() + '/__events';
  const received = (pred) => until(async () => (await (await fetch(events)).json()).some(pred));
  const defaults = (await gateway('/plugins/list')).data;
  const plugins = [
    ...new Set([
      ...defaults,
      'exit-transformer',
      'brotli',
      'opentelemetry',
      'skywalking',
      'node-status',
      'log-rotate',
      'error-log-logger',
      'dubbo-proxy',
      'batch-requests',
      'server-info',
      'ocsp-stapling',
    ]),
  ];
  const config = {
    apisix: {
      node_listen: 9080,
      proxy_mode: 'http&stream',
      stream_proxy: { tcp: [9100] },
      enable_control: true,
      control: { ip: '0.0.0.0', port: 9090 },
    },
    deployment: {
      role: 'traditional',
      role_traditional: { config_provider: 'etcd' },
      etcd: { host: ['http://' + etcdName + ':2379'] },
      admin: {
        allow_admin: ['127.0.0.1', '172.16.0.0/12', '192.168.0.0/16', '10.0.0.0/8'],
        admin_key: [{ name: 'fixture', key: '${{AUDIT_ADMIN_KEY}}', role: 'admin' }],
      },
    },
    nginx_config: {
      worker_processes: 1,
      error_log: '/usr/local/apisix/logs/optional-error.log',
      http: { access_log: '/usr/local/apisix/logs/optional-access.log' },
    },
    plugins,
    stream_plugins: ['mqtt-proxy'],
    plugin_attr: {
      skywalking: {
        report_interval: 1,
        service_name: run,
        endpoint_addr: 'http://' + ip + ':8080',
      },
      'log-rotate': { interval: 10, max_kept: 2 },
      'server-info': { report_ttl: 60 },
    },
  };
  const configFile = new URL('config.yaml', root);
  const runnerMount = [];
  config.nginx_config.error_log_level = 'info';
  if (!focused.size || focused.has('inspect')) {
    const hook = new URL('inspect.lua', root);
    await writeFile(
      hook,
      'local fn = require("apisix.plugins.limit-req").access\nrequire("apisix.inspect.dbg").set_hook("limit-req.lua", debug.getinfo(fn,"S").linedefined + 1, fn, function() ngx.log(ngx.WARN,"order-inspect-observed"); return true end)\n',
    );
    config.plugin_attr.inspect = { delay: 1, hooks_file: '/test-inspect.lua' };
    runnerMount.push('-v', fileURLToPath(hook) + ':/test-inspect.lua:ro');
  }
  if (!focused.size || [...focused].some((name) => name.startsWith('ext-plugin-'))) {
    const dir = new URL('../.local/plugins-audit/runner-v0.5.0/', import.meta.url);
    await mkdir(dir, { recursive: true });
    const binary = fileURLToPath(new URL('go-runner', dir));
    try {
      await access(binary);
    } catch {
      await docker(
        'run',
        '--rm',
        '-v',
        fileURLToPath(dir) + ':/out',
        '-e',
        'GOBIN=/out',
        '-e',
        'CGO_ENABLED=0',
        'golang:1.27.3-bookworm',
        'go',
        'install',
        'github.com/apache/apisix-go-plugin-runner/cmd/go-runner@v0.5.0',
      );
    }
    config['ext-plugin'] = { cmd: ['/test-go-runner', 'run'] };
    runnerMount.push('-v', binary + ':/test-go-runner:ro');
  }
  await writeFile(configFile, stringify(config));
  const gw = await start([
    '--network',
    network,
    ...[9080, 9180, 9090, 9100, 9443].flatMap((port) => ['-p', '127.0.0.1::' + port]),
    '-e',
    'AUDIT_ADMIN_KEY=' + adminKey,
    ...runnerMount,
    '-v',
    fileURLToPath(configFile) + ':/usr/local/apisix/conf/config.yaml:ro',
    image,
  ]);
  const port = async (n) => Number((await docker('port', gw, n + '/tcp')).split(':').pop());
  const [proxy, admin, control, stream] = await Promise.all([9080, 9180, 9090, 9100].map(port));
  const url = (port, path) => 'http://127.0.0.1:' + port + path;
  const api = async (path, body) => {
    const r = await fetch(url(admin, '/apisix/admin' + path), {
      method: body ? 'PUT' : 'GET',
      headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.json();
  };
  await until(() => api('/routes'), 35000);
  const existing = (await gateway('/routes/sandbox-orders-api')).data.value;
  const original = (await gateway('/upstreams/' + existing.upstream_id)).data.value;
  await api('/upstreams/order-upstream', {
    type: original.type,
    nodes: original.nodes,
    scheme: original.scheme,
  });
  const order = '/api/orders/optional';
  const route = (id, plugins, uri = order + '/' + id, extras = {}) =>
    api('/routes/' + id, { name: id, uri, plugins, upstream_id: 'order-upstream', ...extras });
  const hit = (path, options) =>
    fetch(url(proxy, path), { ...options, signal: AbortSignal.timeout(6000) });
  const runRoute = async (id, plugins, extras = {}) => {
    await route(id, plugins, order + '/' + id, extras);
    await sleep(220);
    return hit(order + '/' + id);
  };
  await route('baseline', {}, order);
  await until(async () => (await (await hit(order)).json()).service === 'dashboard-sandbox');
  const metadata = (id, conf) => api('/plugin_metadata/' + id, conf);
  await check('ai', '订单请求命中全局路由匹配优化，网关日志记录 ai_match', async () => {
    const response = await hit(order);
    assert.equal((await response.json()).service, 'dashboard-sandbox');
    await until(async () => {
      await hit(order);
      await docker(
        'exec',
        gw,
        'grep',
        '-q',
        'route match mode: ai_match',
        '/usr/local/apisix/logs/optional-error.log',
      );
      return true;
    });
  });
  await check('inspect', '订单请求执行 limit-req 时命中所配置的诊断断点', async () => {
    await route('inspect-order', { 'limit-req': { rate: 100, burst: 100, key: 'remote_addr' } });
    await until(async () => {
      assert.equal((await hit(order + '/inspect-order')).status, 200);
      await docker(
        'exec',
        gw,
        'grep',
        '-q',
        'order-inspect-observed',
        '/usr/local/apisix/logs/optional-error.log',
      );
      return true;
    });
  });
  await check(
    'mcp-bridge',
    '从 SSE 获取会话，POST 的 JSON-RPC 消息经 stdio 往返后在原 SSE 连接收到',
    async () => {
      const base = order + '/mcp';
      const server =
        'io.stdout:setvbuf("no"); for line in io.lines() do local id=line:match(\'"id"%s*:%s*(%d+)\'); if id then print(\'{"jsonrpc":"2.0","id":\'..id..\',"result":{"tools":[{"name":"order_lookup","inputSchema":{"type":"object"}}]}}\') end end';
      await route(
        'mcp',
        {
          'mcp-bridge': {
            base_uri: base,
            command: '/usr/local/openresty/luajit/bin/luajit',
            args: ['-e', server],
          },
        },
        base + '/*',
      );
      await sleep(300);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 9000);
      try {
        const r = await fetch(url(proxy, base + '/sse'), {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        assert.equal(r.status, 200);
        const reader = r.body.getReader(),
          decoder = new TextDecoder();
        let buffer = '';
        const nextData = async () => {
          for (;;) {
            const end = buffer.indexOf('\n\n');
            if (end >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = block.split('\n').find((line) => line.startsWith('data:'));
              if (data) return data.slice(5).trim();
              continue;
            }
            const part = await reader.read();
            assert.ok(!part.done);
            buffer += decoder.decode(part.value, { stream: true }).replaceAll('\r', '');
          }
        };
        const endpoint = new URL(await nextData(), url(proxy, '/'));
        assert.equal(endpoint.origin, url(proxy, ''));
        assert.ok(endpoint.pathname.startsWith(base + '/'));
        const message = { jsonrpc: '2.0', id: 23, method: 'tools/list' };
        const reply = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        assert.ok(reply.ok, 'message ' + reply.status);
        let answer;
        do {
          answer = JSON.parse(await nextData());
        } while (answer.id !== message.id);
        assert.equal(answer.result.tools[0].name, 'order_lookup');
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  );
  await check('node-status', '状态 API 返回可解析的服务连接统计', async () => {
    const r = await runRoute('node-status', { 'public-api': { uri: '/apisix/status' } });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(Number(data.status.accepted) > 0 && Number(data.status.active) >= 0);
  });
  await check('batch-requests', '两条订单子请求均返回原订单服务响应', async () => {
    await route(
      'batch',
      { 'public-api': { uri: '/apisix/batch-requests' } },
      '/apisix/batch-requests',
    );
    await sleep(250);
    const r = await hit('/apisix/batch-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pipeline: [
          { method: 'GET', path: order },
          { method: 'GET', path: order },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const items = await r.json();
    assert.equal(items.length, 2);
    assert.ok(items.every((x) => x.status === 200 && x.body.includes('dashboard-sandbox')));
  });
  await check('server-info', 'Control API 返回该网关实例的版本与主机信息', async () => {
    const r = await fetch(url(control, '/v1/server_info'));
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(JSON.stringify(data).includes('3.19'));
  });
  await check('exit-transformer', '把缺少凭据的 401 改为配置的 409', async () => {
    assert.equal(
      (
        await runRoute('exit', {
          'key-auth': {},
          'exit-transformer': {
            functions: ['local code,body,headers=...; return 409, body, headers'],
          },
        })
      ).status,
      409,
    );
  });
  await check('brotli', '协商 br 压缩，解压后仍为完整订单 JSON', async () => {
    await route('br', { brotli: { min_length: 1, types: ['application/json'] } });
    await sleep(220);
    const http = await import('node:http');
    const bytes = await new Promise((resolve, reject) => {
      http
        .get(url(proxy, order + '/br'), { headers: { 'accept-encoding': 'br' } }, (r) => {
          const chunks = [];
          r.on('data', (x) => chunks.push(x));
          r.on('end', () =>
            resolve({ encoding: r.headers['content-encoding'], data: Buffer.concat(chunks) }),
          );
        })
        .on('error', reject);
    });
    assert.equal(bytes.encoding, 'br');
    assert.equal(JSON.parse(brotliDecompressSync(bytes.data)).service, 'dashboard-sandbox');
  });
  await check('datadog', '私有元数据配置的 UDP 端收到了本路由 DogStatsD 指标', async () => {
    await metadata('datadog', { host: ip, port: 15141, namespace: 'audit' });
    assert.equal(
      (await runRoute('dog', { datadog: { prefer_name: true, batch_max_size: 1 } })).status,
      200,
    );
    await received(
      (e) => e.protocol === 'udp' && e.body.includes('dog') && e.body.includes('audit'),
    );
  });
  await check('loggly', '私有元数据配置的 HTTP 接收端收到日志', async () => {
    await metadata('loggly', { host: ip + ':8080', protocol: 'http' });
    assert.equal(
      (await runRoute('lg', { loggly: { customer_token: 'fixture-token', batch_max_size: 1 } }))
        .status,
      200,
    );
    await received((e) => e.protocol === 'http' && e.body.includes(order + '/lg'));
  });
  await check('skywalking', '订单请求产生可在本地 OAP 协议端识别的 trace', async () => {
    assert.equal((await runRoute('sky', { skywalking: { sample_ratio: 1 } })).status, 200);
    await received((e) => e.url?.includes('segment') && e.body.includes(order + '/sky'));
  });
  await check('opentelemetry', '本地 OTLP 接收端收到订单请求的导出 span', async () => {
    await metadata('opentelemetry', {
      collector: { address: ip + ':8080' },
      resource: { 'service.name': run },
      batch_span_processor: { max_export_batch_size: 1, batch_timeout: 1 },
    });
    assert.equal(
      (await runRoute('otel', { opentelemetry: { sampler: { name: 'always_on' } } })).status,
      200,
    );
    await received((e) => e.url?.includes('/v1/traces') && e.body.includes(run));
  });
  await check('error-log-logger', '隔离网关产生的指定日志送达 TCP 接收端', async () => {
    await metadata('error-log-logger', { tcp: { host: ip, port: 15140 }, level: 'WARN' });
    await runRoute('errors', {
      'serverless-pre-function': {
        phase: 'rewrite',
        functions: ['return function() ngx.log(ngx.WARN,"' + run + '-error-event") end'],
      },
    });
    await received((e) => e.protocol === 'tcp' && e.body.includes(run + '-error-event'));
  });
  await check('log-rotate', '写入订单访问记录后隔离网关轮转日志', async () => {
    await hit(order);
    await until(async () => {
      const ls = await docker('exec', gw, 'ls', '/usr/local/apisix/logs');
      return /\d{4}.*(?:access|error)\.log/.test(ls);
    }, 28000);
  });
  await check('mqtt-proxy', '原生 MQTT CONNECT 经 Stream 路由得到 broker 的 CONNACK', async () => {
    await api('/stream_routes/mqtt', {
      server_port: 9100,
      plugins: { 'mqtt-proxy': { protocol_name: 'MQTT', protocol_level: 4 } },
      upstream: { type: 'chash', key: 'mqtt_client_id', nodes: { [ip + ':1883']: 1 } },
    });
    await sleep(250);
    const packet = Buffer.from('101100044d5154540402003c00056f72646572', 'hex');
    const result = await new Promise((resolve, reject) => {
      const s = net.connect(stream, '127.0.0.1', () => s.write(packet));
      s.setTimeout(3000, () => s.destroy(new Error('MQTT timeout')));
      s.on('error', reject);
      s.once('data', (data) => {
        resolve(data);
        s.end();
      });
      s.once('close', () => resolve(Buffer.alloc(0)));
    });
    assert.equal(result.toString('hex'), '20020000');
    await received((e) => e.protocol === 'mqtt' && e.body.includes('order'));
  });
  await check(
    'chaitin-waf',
    '缺少元数据有诊断信息；本地 T1K 决策放行订单、拦截返回 403，观察模式仍放行并标注决策',
    async () => {
      const plugin = { mode: 'block', append_waf_resp_header: true, append_waf_debug_header: true };
      const r = await runRoute('waf', { 'chaitin-waf': plugin });
      assert.equal(r.status, 500);
      assert.match(r.headers.get('x-apisix-chaitin-waf-error') || '', /metadata/i);
      await metadata('chaitin-waf', { nodes: [{ host: ip, port: 19800 }] });
      await until(async () => {
        const result = await hit(order + '/waf');
        return (
          result.status === 200 && result.headers.get('x-apisix-chaitin-waf-action') === 'pass'
        );
      });
      const deny = { headers: { 'x-test-decision': 'deny' } };
      const blocked = await hit(order + '/waf', deny);
      assert.equal(blocked.status, 403);
      assert.ok((await blocked.text()).includes('OrderQA'));
      await route('waf', { 'chaitin-waf': { ...plugin, mode: 'monitor' } });
      await until(async () => {
        const res = await hit(order + '/waf', deny);
        return (
          res.status === 200 &&
          res.headers.get('x-apisix-chaitin-waf-action') === 'reject' &&
          (await res.json()).service === 'dashboard-sandbox'
        );
      });
    },
  );
  await check(
    'dubbo-proxy',
    '调用配置的 Dubbo 服务并将 Hessian2 应答转换为业务 HTTP 正文与响应头',
    async () => {
      await route(
        'dubbo',
        {
          'dubbo-proxy': { service_name: 'orders.Lookup', service_version: '1.0.0', method: 'get' },
        },
        order + '/dubbo',
        { upstream_id: undefined, upstream: { type: 'roundrobin', nodes: { [ip + ':20880']: 1 } } },
      );
      await sleep(300);
      const res = await hit(order + '/dubbo');
      await received((e) => e.protocol === 'dubbo' && e.body.includes('orders.Lookup'));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'local-dubbo-order');
      assert.equal(res.headers.get('x-order-peer'), 'fixture');
    },
  );
  for (const name of ['ext-plugin-pre-req', 'ext-plugin-post-req', 'ext-plugin-post-resp']) {
    await check(
      name,
      '官方 Go Runner 执行对应阶段，业务响应包含 Runner 返回的正文和响应头',
      async () => {
        const supplied = run + '-' + name;
        const conf = {
          name: name === 'ext-plugin-post-resp' ? 'response-rewrite' : 'say',
          value: JSON.stringify({ body: supplied }),
        };
        await route(name, { [name]: { conf: [conf] } });
        await until(async () => {
          const r = await hit(order + '/' + name);
          return (
            r.status === 200 &&
            r.headers.get('x-resp-a6-runner') === 'Go' &&
            (await r.text()) === supplied
          );
        });
      },
    );
  }
  await check(
    'ocsp-stapling',
    '客户端验证证书链，并在 TLS 握手中收到与测试 CA 签名结果完全相同的 OCSP 响应',
    async () => {
      const chain = JSON.parse(
        (
          await promisify(execFile)('python', [
            fileURLToPath(new URL('./fixtures/ocsp-fixture.py', import.meta.url)),
            'http://' + ip + ':8080/ocsp',
          ])
        ).stdout,
      );
      assert.ok(
        (
          await fetch(events.replace('/__events', '/__ocsp'), {
            method: 'PUT',
            body: chain.response,
          })
        ).ok,
      );
      await api('/ssls/order', {
        snis: ['order.example.test'],
        cert: chain.leaf + chain.ca,
        key: chain.key,
        ocsp_stapling: { enabled: true, skip_verify: false },
      });
      const ssl = await port(9443);
      await until(
        () =>
          new Promise((resolve, reject) => {
            let received;
            const s = tls.connect({
              host: '127.0.0.1',
              port: ssl,
              servername: 'order.example.test',
              requestOCSP: true,
              ca: chain.ca,
              maxVersion: 'TLSv1.2',
            });
            s.on('error', reject);
            s.setTimeout(4000, () => s.destroy(new Error('TLS timeout')));
            s.on('OCSPResponse', (data) => {
              received = data?.toString('base64');
            });
            s.on('secureConnect', () => {
              const ok = s.authorized && received === chain.response;
              s.end();
              resolve(ok);
            });
          }),
      );
    },
  );
  if (!focused.size || focused.has('gm')) {
    const info = await docker(
      'exec',
      gw,
      '/usr/local/openresty/bin/resty',
      '-e',
      'local f=require("ffi");f.cdef[[unsigned long Tongsuo_version_num(void);]];print(pcall(function()return f.C.Tongsuo_version_num() end))',
    );
    report.rows.gm = {
      result: 'requires-dependency',
      limitation: info.startsWith('false')
        ? '已实测当前网关未链接 Tongsuo，国密握手需要 Tongsuo 网关与国密双证书'
        : '需要国密双证书完成握手测试',
    };
  }
  if (Object.values(report.rows).some((x) => x.result === 'failed')) {
    report.diagnostics = (
      await docker(
        'exec',
        gw,
        'sh',
        '-c',
        "grep -hE 'failed to load plugin|failed to load the plugin|failed to load:|error loading module' /usr/local/apisix/logs/*error.log | head -c 3000",
      )
    )
      .split('\n')
      .filter(Boolean);
  }
} finally {
  for (const id of containers.reverse()) await docker('stop', id).catch(() => {});
  report.cleanup = (
    await Promise.all(containers.map((id) => docker('ps', '-aq', '--filter', 'id=' + id)))
  ).every((id) => !id);
  const file = new URL('report.json', root);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log(fileURLToPath(file), 'cleanup:', report.cleanup);
  assert.ok(report.cleanup);
}
for (const name of focused) assert.ok(report.rows[name], 'No isolated gateway test for ' + name);

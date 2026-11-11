import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';

const client = await sandboxClient();
const { request, gateway, waitChange, cookie, session } = client;
const cluster = (await request('/clusters')).find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
assert.ok(cluster, 'Tests require the dedicated local gateway');
const prefix = `advanced-${Date.now()}`;
const route = `${prefix}-route`,
  service = `${prefix}-service`,
  shared = `${prefix}-plugins`;
const resourcePath = `/clusters/${cluster.id}/resources`;
const previewPath = `/clusters/${cluster.id}/validate`;
const checks = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const reject = (promise, status) => assert.rejects(promise, (error) => error.status === status);
const basic = { uri: `/${prefix}/*`, upstream: { type: 'roundrobin', nodes: { 'echo:80': 1 } } };
const preview = (value, extra = {}) =>
  request(previewPath, 'POST', { resource_type: 'routes', resource_id: route, value, ...extra });
const drafts = [];
let readOnlyChanged = false;
async function create(value, id = route) {
  const d = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: 'routes',
    resource_id: id,
    action: 'create',
    title: prefix,
    value,
  });
  drafts.push(d.id);
  return d;
}
async function publish(d) {
  const c = await request('/changesets', 'POST', {
    draft_ids: [d.id],
    title: prefix,
    reason: '高级路由本地网关验收',
  });
  const validation = await request(`/changesets/${c.id}/validate`, 'POST', {});
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  await request(`/changesets/${c.id}/publish`, 'POST', {});
  const result = await waitChange(c.id);
  assert.equal(result.status, 'succeeded', JSON.stringify(result.operations));
  return c;
}
async function update(value) {
  const live = await request(`${resourcePath}/routes/${route}`);
  const d = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: 'routes',
    resource_id: route,
    action: 'update',
    title: prefix,
    base_hash: live.hash,
    value,
  });
  drafts.push(d.id);
  return publish(d);
}
async function traffic(path, options = {}) {
  for (let i = 0; i < 30; i++) {
    const response = await sandboxProxy(`http://127.0.0.1:19080${path}`, {
      redirect: 'manual',
      ...options,
    });
    if (response.status !== 404) return response;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Route did not propagate: ${path}`);
}
const clusterBody = {
  name: cluster.name,
  environment: cluster.environment,
  url: cluster.url,
  description: cluster.description,
  read_only: false,
};
try {
  assert.equal(
    (
      await fetch(`http://127.0.0.1:18080/api/v1${previewPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:18080/api/v1${previewPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      })
    ).status,
    403,
  );
  await reject(request(previewPath, 'POST', { resource_type: 'unsupported', value: {} }), 400);
  await reject(preview(basic, { resource_id: '../bad' }), 400);
  record('未保存校验接口的登录、CSRF、资源类型与 ID 边界');

  const beforeDrafts = await request(`/drafts?cluster_id=${cluster.id}`);
  const beforeRoutes = await request(`${resourcePath}/routes`);
  assert.equal((await preview(basic)).ok, true);
  assert.deepEqual(await request(`/drafts?cluster_id=${cluster.id}`), beforeDrafts);
  assert.deepEqual(await request(`${resourcePath}/routes`), beforeRoutes);
  record('未保存校验通过且不会创建草稿或改变网关配置');

  for (const bad of [
    { ...basic, methods: ['INVALID'] },
    { ...basic, vars: ['OR', ['arg_x', '==', 'one']] },
    {
      ...basic,
      plugins: {
        'proxy-rewrite': { uri: '/x', _meta: { filter: ['AND', ['arg_x', '==', 'one']] } },
      },
    },
    { ...basic, plugins: { 'limit-req': { rate: -1, burst: 1, key: 'remote_addr' } } },
    { ...basic, plugins: { redirect: { uri: '/new', regex_uri: ['a', 'b'] } } },
  ])
    assert.equal((await preview(bad)).ok, false);
  for (const key of ['upstream_id', 'service_id', 'plugin_config_id']) {
    const bad = { uri: basic.uri, [key]: `${prefix}-missing` };
    const result = await preview(bad);
    assert.equal(result.ok, false, JSON.stringify(result));
  }
  record('无效方法、插件参数、重定向互斥项和三类缺失引用均被阻止');

  assert.equal(
    (
      await gateway(`/services/${service}`, 'PUT', {
        name: '高级路由测试服务',
        upstream: basic.upstream,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await gateway(`/plugin_configs/${shared}`, 'PUT', {
        desc: '高级路由测试共享插件',
        plugins: {
          'response-rewrite': { headers: { set: { 'X-Shared-Config': 'inherited' } } },
          'request-id': { header_name: 'X-Dashboard-Reference-Id', include_in_response: true },
        },
      })
    ).status,
    201,
  );
  assert.ok((await request(`${resourcePath}/services`)).items.some((s) => s.id === service));
  assert.ok((await request(`${resourcePath}/plugin_configs`)).items.some((s) => s.id === shared));
  assert.equal(
    (await request(`${resourcePath}/services/${service}`)).value.name,
    '高级路由测试服务',
  );
  for (const kind of ['services', 'plugin_configs'])
    await reject(
      request('/drafts', 'POST', {
        cluster_id: cluster.id,
        resource_type: kind,
        resource_id: prefix,
        action: 'create',
        value: {},
      }),
      400,
    );
  record('服务和共享插件可查询引用，空配置不能保存为草稿');

  const inherited = { uri: basic.uri, service_id: service, plugin_config_id: shared };
  for (const [ref, status] of [
    [shared, 200],
    [42, 200],
    [[shared, 'second'], 400],
  ]) {
    assert.equal(
      (await gateway('/schema/validate/routes', 'POST', { ...inherited, plugin_config_id: ref }))
        .status,
      status,
    );
  }
  record('真实路由 Schema 接受字符串或数字的单个共享 ID，拒绝多个 ID 数组');
  assert.equal((await preview(inherited)).ok, true);
  await publish(await create(inherited));
  let response = await traffic(`/${prefix}/hello`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Shared-Config'), 'inherited');
  assert.ok(response.headers.get('X-Dashboard-Reference-Id'));
  record('一份共享配置同时提供 request-id 和 response-rewrite，实际响应包含两个结果');

  async function checkReference(inheritedHeader, localHeader, hasRequestId) {
    let actual;
    for (let attempt = 0; attempt < 35; attempt++) {
      const res = await traffic('/' + prefix + '/hello');
      actual = [
        res.status,
        res.headers.get('X-Shared-Config'),
        res.headers.get('X-Local-Config'),
        !!res.headers.get('X-Dashboard-Reference-Id'),
      ];
      if (
        actual[0] === 200 &&
        actual[1] === inheritedHeader &&
        actual[2] === localHeader &&
        actual[3] === hasRequestId
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(actual, [200, inheritedHeader, localHeader, hasRequestId]);
  }
  const policy = await request(resourcePath + '/plugin_configs/' + shared);
  const routeBaseline = (await request(resourcePath + '/routes/' + route)).hash;
  policy.value.plugins['response-rewrite'].headers.set['X-Shared-Config'] = 'updated';
  const policyDraft = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: 'plugin_configs',
    resource_id: shared,
    action: 'update',
    base_hash: policy.hash,
    value: policy.value,
    title: prefix,
  });
  drafts.push(policyDraft.id);
  await checkReference('inherited', null, true);
  const policyChange = await publish(policyDraft);
  await checkReference('updated', null, true);
  const undoPolicy = await request('/changesets/' + policyChange.id + '/rollback', 'POST', {});
  await request('/changesets/' + undoPolicy.id + '/publish', 'POST', {});
  assert.equal((await waitChange(undoPolicy.id)).status, 'succeeded');
  await checkReference('inherited', null, true);
  assert.equal((await request(resourcePath + '/routes/' + route)).hash, routeBaseline);
  record('共享组草稿、发布与回退在实际响应中依次验证，路由配置哈希保持一致');
  await update({
    ...inherited,
    plugins: { 'response-rewrite': { headers: { set: { 'X-Local-Config': 'override' } } } },
  });
  await checkReference(null, 'override', true);
  record('同名路由插件整体替代共享插件，另一个共享插件继续执行');
  await update({ ...inherited, plugins: { 'response-rewrite': { _meta: { disable: true } } } });
  await checkReference(null, null, true);
  record('路由停用同名插件时不回落到共享版本，其余共享插件继续执行');
  await update({ uri: basic.uri, service_id: service });
  await checkReference(null, null, false);
  await update(inherited);
  await checkReference('inherited', null, true);
  record('解除共享引用后两个效果均消失，恢复引用后同时生效');

  const secretValue = {
    ...inherited,
    plugins: {
      'proxy-rewrite': { headers: { set: { 'X-Private-Token': 'route-test-sensitive' } } },
    },
  };
  const live = await request(`${resourcePath}/routes/${route}`);
  let d = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: 'routes',
    resource_id: route,
    action: 'update',
    base_hash: live.hash,
    title: prefix,
    value: secretValue,
  });
  drafts.push(d.id);
  assert.equal(
    d.after.plugins['proxy-rewrite'].headers.set['X-Private-Token'],
    '${dashboard:keep-secret}',
  );
  const validated = await preview(d.after, { draft_id: d.id });
  assert.equal(validated.ok, true);
  assert.ok(!JSON.stringify(validated).includes('route-test-sensitive'));
  assert.equal((await request(`/drafts/${d.id}`)).revision, d.revision);
  await reject(preview(d.after, { draft_id: d.id, resource_id: `${route}-other` }), 400);
  await reject(
    preview({
      uri: basic.uri,
      plugins: {
        'proxy-rewrite': { headers: { set: { 'X-New-Token': '${dashboard:keep-secret}' } } },
      },
    }),
    400,
  );
  await publish(d);
  assert.equal(
    (await gateway(`/routes/${route}`)).data.value.plugins['proxy-rewrite'].headers.set[
      'X-Private-Token'
    ],
    'route-test-sensitive',
  );
  record('草稿密钥占位符校验保留原值、拒绝错绑草稿且不暴露密钥');

  await request(`/clusters/${cluster.id}`, 'PUT', { ...clusterBody, read_only: true });
  readOnlyChanged = true;
  assert.equal((await preview(basic)).ok, true);
  await reject(create(basic, `${prefix}-readonly`), 403);
  assert.ok((await request(`${resourcePath}/services`)).items.some((s) => s.id === service));
  await request(`/clusters/${cluster.id}`, 'PUT', clusterBody);
  readOnlyChanged = false;
  record('只读集群允许预览与读取，禁止保存新草稿');

  const expression = {
    ...basic,
    methods: ['GET'],
    vars: [
      ['arg_version', '==', 'v2'],
      ['OR', ['http_x_tenant', '==', 'platform'], ['cookie_team', '==', 'platform']],
      ['arg_block', '!', '==', 'yes'],
    ],
  };
  await update(expression);
  assert.equal(
    (await traffic(`/${prefix}/hello?version=v2`, { headers: { 'X-Tenant': 'platform' } })).status,
    200,
  );
  assert.equal(
    (await traffic(`/${prefix}/hello?version=v2`, { headers: { Cookie: 'team=platform' } })).status,
    200,
  );
  for (const [path, options] of [
    [`/${prefix}/hello?version=v1`, { headers: { 'X-Tenant': 'platform' } }],
    [`/${prefix}/hello?version=v2&block=yes`, { headers: { 'X-Tenant': 'platform' } }],
    [`/${prefix}/hello?version=v2`, { headers: { 'X-Tenant': 'other' } }],
    [`/${prefix}/hello?version=v2`, { method: 'POST', headers: { 'X-Tenant': 'platform' } }],
  ])
    assert.equal((await sandboxProxy(`http://127.0.0.1:19080${path}`, options)).status, 404);
  record('嵌套 AND/OR、请求头、Cookie、Query、否定条件和 HTTP 方法匹配实际生效');

  const rewrite = {
    ...basic,
    plugins: {
      'proxy-rewrite': {
        regex_uri: [
          `^/${prefix}/a/(.*)`,
          '/__inspect/a/$1',
          `^/${prefix}/b/(.*)`,
          '/__inspect/b/$1',
        ],
        headers: {
          set: { 'X-Console-Set': 'yes' },
          add: { 'X-Console-Add': 'new' },
          remove: ['X-Console-Remove'],
        },
      },
    },
  };
  await update(rewrite);
  for (const variant of ['a', 'b']) {
    const text = await (
      await traffic(`/${prefix}/${variant}/42?q=keep`, {
        headers: { 'X-Console-Add': 'existing', 'X-Console-Remove': 'gone' },
      })
    ).text();
    assert.ok(text.includes(`uri=/__inspect/${variant}/42\nargs=q=keep`), text);
    assert.ok(text.includes('set=yes\nadd=existing, new\nremove=\n'), text);
  }
  record('多组正则路径改写与请求头追加、移除、覆盖在真实请求中生效');

  for (const status of [301, 302, 307, 308]) {
    await update({
      uri: basic.uri,
      plugins: {
        redirect: { uri: 'https://example.test/new', ret_code: status, append_query_string: true },
      },
    });
    response = await traffic(`/${prefix}/old?version=v2`);
    // Wait for etcd watches when the route already existed.
    for (let i = 0; i < 30 && response.status !== status; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await traffic(`/${prefix}/old?version=v2`);
    }
    assert.equal(response.status, status);
    assert.equal(response.headers.get('location'), 'https://example.test/new?version=v2');
  }
  record('301/302/307/308 重定向状态与查询参数追加实际生效');
  await update({
    uri: basic.uri,
    plugins: {
      redirect: {
        regex_uri: [`^/${prefix}/(.*)`, 'https://example.test/archive/$1'],
        ret_code: 302,
      },
    },
  });
  response = await traffic(`/${prefix}/order/42`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://example.test/archive/order/42');
  record('正则重定向替换捕获分组实际生效');
  await update({ uri: basic.uri, plugins: { redirect: { http_to_https: true } } });
  response = await traffic(`/${prefix}/secure?x=1`, { headers: { Host: 'console.test' } });
  assert.equal(response.status, 301);
  assert.ok(response.headers.get('location').startsWith('https://console.test'));
  assert.ok(response.headers.get('location').endsWith(`/${prefix}/secure?x=1`));
  record('HTTP 转 HTTPS 保留 Host、路径及查询参数');

  for (const upstream of [
    {
      type: 'chash',
      hash_on: 'header',
      key: 'X-Tenant',
      scheme: 'https',
      nodes: [{ host: '::1', port: 443, weight: 1, priority: 0 }],
      pass_host: 'rewrite',
      upstream_host: 'example.test',
      retries: 0,
      retry_timeout: 0,
      keepalive_pool: { size: 32, idle_timeout: 10, requests: 100 },
    },
    {
      type: 'least_conn',
      discovery_type: 'dns',
      service_name: 'example.test',
      timeout: { connect: 2, send: 2, read: 5 },
    },
    {
      nodes: { 'echo:80': 1 },
      checks: {
        active: {
          type: 'https',
          host: 'example.test',
          http_path: '/health',
          https_verify: false,
          req_headers: ['X-Health: 1'],
          healthy: { interval: 1, successes: 1, http_statuses: [200] },
          unhealthy: { interval: 1, http_failures: 1 },
        },
        passive: { type: 'http', healthy: { successes: 1 }, unhealthy: { http_failures: 1 } },
      },
    },
  ])
    assert.equal((await preview({ ...basic, upstream })).ok, true);
  record('IPv6 节点、哈希、指定 Host、连接池、DNS 发现、主动/被动检查通过目标 Schema');

  const beforeRollback = { ...basic, plugins: { 'proxy-rewrite': { uri: '/__inspect/original' } } };
  await update(beforeRollback);
  const changed = await update({
    ...basic,
    plugins: { 'proxy-rewrite': { uri: '/__inspect/changed' } },
  });
  assert.ok((await (await traffic(`/${prefix}/hello`)).text()).includes('uri=/__inspect/changed'));
  const rollback = await request(`/changesets/${changed.id}/rollback`, 'POST', {});
  assert.ok((await (await traffic(`/${prefix}/hello`)).text()).includes('uri=/__inspect/changed'));
  await request(`/changesets/${rollback.id}/publish`, 'POST', {});
  assert.equal((await waitChange(rollback.id)).status, 'succeeded');
  assert.ok((await (await traffic(`/${prefix}/hello`)).text()).includes('uri=/__inspect/original'));
  record('更新回退只有发布后生效，并恢复实际请求路径');

  const probe = await request(`/clusters/${cluster.id}/probe`, 'POST', {});
  const report = {
    timestamp: new Date().toISOString(),
    gateway: probe,
    passed: checks.length,
    checks,
  };
  await writeFile(
    new URL('../.local/route-editor-integration.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({ passed: checks.length, report: '.local/route-editor-integration.json' }),
  );
} finally {
  if (readOnlyChanged) await request(`/clusters/${cluster.id}`, 'PUT', clusterBody);
  await gateway(`/routes/${route}`, 'DELETE');
  await gateway(`/services/${service}`, 'DELETE');
  await gateway(`/plugin_configs/${shared}`, 'DELETE');
  for (const id of drafts) {
    const d = await request(`/drafts/${id}`).catch(() => null);
    if (d?.status === 'draft') await request(`/drafts/${id}`, 'DELETE');
  }
}

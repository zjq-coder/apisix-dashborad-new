import { sandboxClient } from './sandbox-client.mjs';

const { config, request, waitChange } = await sandboxClient();
let cluster = (await request('/clusters')).find((c) => c.url === 'http://apisix:9180/apisix/admin');
if (!cluster)
  cluster = await request('/clusters', 'POST', {
    name: '本地开发网关',
    environment: 'development',
    url: 'http://apisix:9180',
    api_key: config.APISIX_ADMIN_KEY,
    description: '项目专用 APISIX 测试实例，用于体验配置闭环。',
    read_only: false,
  });
let probe;
for (let attempt = 0; attempt < 8; attempt++) {
  probe = await request(`/clusters/${cluster.id}/probe`, 'POST', {});
  if (probe.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!probe.ok) throw new Error('Gateway probe failed: ' + JSON.stringify(probe.checks));
const upstreams = [
  {
    id: 'sandbox-orders',
    name: 'orders-service',
    desc: '订单服务 · 本地测试',
    type: 'roundrobin',
    scheme: 'http',
    nodes: { 'echo:80': 1 },
    timeout: { connect: 6, send: 6, read: 6 },
  },
  {
    id: 'sandbox-users',
    name: 'users-service',
    desc: '用户服务 · 本地测试',
    type: 'roundrobin',
    scheme: 'http',
    nodes: { 'echo:80': 1 },
  },
];
const routes = [
  {
    id: 'sandbox-orders-api',
    name: 'order-api',
    desc: '订单接口 · 应用组',
    uri: '/api/orders/*',
    methods: ['GET', 'POST'],
    upstream_id: 'sandbox-orders',
    status: 1,
    labels: { team: 'application' },
    plugins: {
      'limit-req': { rate: 100, burst: 50, key: 'remote_addr', rejected_code: 429 },
      'request-id': { include_in_response: true },
    },
  },
  {
    id: 'sandbox-users-api',
    name: 'user-api',
    desc: '用户接口 · 应用组',
    uri: '/api/users/*',
    methods: ['GET', 'POST', 'PUT'],
    upstream_id: 'sandbox-users',
    status: 1,
    plugins: { cors: {} },
  },
  {
    id: 'sandbox-health',
    name: 'health-check',
    desc: '健康检查 · 平台组',
    uri: '/health',
    methods: ['GET'],
    upstream_id: 'sandbox-orders',
    status: 1,
  },
  {
    id: 'sandbox-legacy',
    name: 'legacy-export',
    desc: '历史导出 · 数据组',
    uri: '/legacy/export/*',
    methods: ['POST'],
    upstream_id: 'sandbox-orders',
    status: 0,
  },
];
const drafts = [];
for (const [kind, items] of [
  ['upstreams', upstreams],
  ['routes', routes],
]) {
  const existing = new Set(
    (await request(`/clusters/${cluster.id}/resources/${kind}`)).items.map((r) => r.id),
  );
  for (const item of items)
    if (!existing.has(item.id)) {
      const { id, ...value } = item;
      const d = await request('/drafts', 'POST', {
        cluster_id: cluster.id,
        resource_type: kind,
        resource_id: id,
        action: 'create',
        title: value.name,
        value,
      });
      drafts.push(d.id);
    }
}
if (drafts.length) {
  const change = await request('/changesets', 'POST', {
    draft_ids: drafts,
    title: '初始化本地开发网关',
    reason: '通过控制台发布服务创建项目专用示例配置，用于开发和验收。',
  });
  const validation = await request(`/changesets/${change.id}/validate`, 'POST', {});
  if (!validation.ok) throw new Error(JSON.stringify(validation.checks));
  await request(`/changesets/${change.id}/publish`, 'POST', {});
  const result = await waitChange(change.id);
  if (result.status !== 'succeeded')
    throw new Error(
      JSON.stringify({
        status: result.status,
        operations: result.operations.map((o) => ({
          resource: o.resource_id,
          status: o.status,
          error: o.error,
          before: o.before,
          after: o.after,
          actual: o.actual_after,
        })),
      }),
    );
  console.log(`Seeded ${drafts.length} resources through a verified release.`);
}
console.log(`Sandbox ready. Cluster ID: ${cluster.id}. APISIX: ${probe.version || '未探测'}.`);

import { readFile } from 'node:fs/promises';
import { sandboxClient } from './sandbox-client.mjs';

const { request, waitChange } = await sandboxClient();
const url = 'http://apisix-staging:9180/apisix/admin';
const clusters = await request('/clusters');
let cluster = clusters.find((item) => item.url === url && item.environment === 'staging');
if (!cluster) {
  const settings = await readFile(new URL('../.local/staging.env', import.meta.url), 'utf8');
  const key = settings.match(/^APISIX_ADMIN_KEY=([a-f0-9]{64})\r?$/m)?.[1];
  if (!key) throw new Error('Expected a 32-byte hex APISIX_ADMIN_KEY in .local/staging.env');
  cluster = await request('/clusters', 'POST', {
    name: '本地测试网关',
    environment: 'staging',
    url,
    api_key: key,
    description: '独立的本地 Docker 测试环境，业务端口 29080。',
  });
}
const probe = await request(`/clusters/${cluster.id}/probe`, 'POST', {});
if (!probe.ok) throw new Error(JSON.stringify(probe.checks));
const fixtures = [
  [
    'upstreams',
    'staging-echo',
    { name: 'staging-echo', type: 'roundrobin', nodes: { 'echo-staging:80': 1 } },
  ],
  [
    'routes',
    'staging-env-check',
    {
      name: 'staging-env-check',
      uri: '/__env/staging',
      methods: ['GET'],
      upstream_id: 'staging-echo',
      status: 1,
    },
  ],
];
const draftIds = [];
for (const [kind, id, value] of fixtures) {
  const list = await request(`/clusters/${cluster.id}/resources/${kind}`);
  if (list.items.some((item) => item.id === id)) continue;
  const draft = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: kind,
    resource_id: id,
    action: 'create',
    title: id,
    value,
  });
  draftIds.push(draft.id);
}
if (draftIds.length) {
  const change = await request('/changesets', 'POST', {
    draft_ids: draftIds,
    title: '初始化测试环境示例路由',
    reason: '验证多环境切换和网关流量隔离',
  });
  const checks = await request(`/changesets/${change.id}/validate`, 'POST', {});
  if (!checks.ok) throw new Error(JSON.stringify(checks.checks));
  await request(`/changesets/${change.id}/publish`, 'POST', {});
  if ((await waitChange(change.id)).status !== 'succeeded')
    throw new Error('Staging release failed: ' + change.id);
  console.log('Release:', change.id);
}
console.log('Staging cluster:', cluster.id, 'APISIX:', probe.version);

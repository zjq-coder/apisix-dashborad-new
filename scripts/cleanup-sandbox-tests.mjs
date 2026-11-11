import { sandboxClient } from './sandbox-client.mjs';

const { request, gateway } = await sandboxClient();
const cluster = (await request('/clusters')).find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
if (!cluster) throw new Error('Dedicated local sandbox connection not found.');
const owned = (id) => /^(e2e|it)-[0-9]+-(route|upstream|up)$/.test(id);
for (const kind of ['routes', 'upstreams']) {
  const items = (await request(`/clusters/${cluster.id}/resources/${kind}`)).items;
  for (const resource of items.filter((r) => owned(r.id))) {
    const result = await gateway(`/${kind}/${resource.id}`, 'DELETE');
    if (![200, 404].includes(result.status))
      throw new Error(`Cannot clean test resource: ${resource.id}`);
  }
}
for (const draft of await request(`/drafts?cluster_id=${cluster.id}`)) {
  if (owned(draft.resource_id) && draft.status === 'draft')
    await request(`/drafts/${draft.id}`, 'DELETE');
}
console.log('Temporary local test resources cleaned; release history retained.');

import assert from 'node:assert/strict';
import { sandboxClient } from './sandbox-client.mjs';

const client = await sandboxClient();
const { request, gateway, waitChange, cookie, config, session } = client;
const cluster = (await request('/clusters')).find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
assert.ok(
  cluster,
  'Run scripts/seed-sandbox.mjs first. Tests only target the dedicated local gateway.',
);
const probe = await request(`/clusters/${cluster.id}/probe`, 'POST', {});
assert.equal(probe.ok, true, 'Local gateway probe must succeed.');
const prefix = `it-${Date.now()}`;
const uid = `${prefix}-up`;
const rid = `${prefix}-route`;
const checks = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const reject = async (promise, status) =>
  assert.rejects(promise, (error) => error.status === status);
const draft = (kind, id, action, value, base_hash) =>
  request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: kind,
    resource_id: id,
    action,
    title: `${prefix} ${action}`,
    value,
    base_hash,
  });
const change = (drafts) =>
  request('/changesets', 'POST', {
    draft_ids: drafts.map((d) => d.id),
    title: prefix,
    reason: '项目专用本地 APISIX 自动化验收',
  });
const resource = (kind, id) => request(`/clusters/${cluster.id}/resources/${kind}/${id}`);
const updateDraft = (d, value, revision = d.revision) =>
  request(`/drafts/${d.id}`, 'PUT', {
    cluster_id: d.cluster_id,
    resource_type: d.resource_type,
    resource_id: d.resource_id,
    action: d.action,
    title: d.title,
    value,
    revision,
  });
const publish = async (c) => {
  await request(`/changesets/${c.id}/publish`, 'POST', {});
  const result = await waitChange(c.id);
  assert.equal(
    result.status,
    'succeeded',
    JSON.stringify(result.operations.map((o) => ({ status: o.status, error: o.error }))),
  );
  return result;
};
const clusterBody = {
  name: cluster.name,
  environment: cluster.environment,
  url: cluster.url,
  description: cluster.description,
  read_only: false,
};
const createdDrafts = [];
let toggled = false;
try {
  assert.equal((await fetch('http://127.0.0.1:18080/api/v1/clusters')).status, 401);
  assert.equal(
    (
      await fetch('http://127.0.0.1:18080/api/v1/drafts', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch('http://127.0.0.1:18080/api/v1/drafts', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrf_token,
          Origin: 'https://untrusted.invalid',
        },
        body: '{}',
      })
    ).status,
    403,
  );
  record('登录、CSRF 和跨域保护');
  assert.ok(!JSON.stringify(await request('/clusters')).includes(config.APISIX_ADMIN_KEY));
  await reject(
    request(`/clusters/${cluster.id}`, 'PUT', { ...clusterBody, url: 'http://other-gateway:9180' }),
    409,
  );
  record('管理密钥不回显，集群目标不可偷换');

  const plugin = `/clusters/${cluster.id}/plugins/limit-req/validate`;
  await reject(request(plugin, 'POST', { value: { rate: -1, burst: 1, key: 'remote_addr' } }), 422);
  assert.equal(
    (await request(plugin, 'POST', { value: { rate: 10, burst: 1, key: 'remote_addr' } })).ok,
    true,
  );
  record('插件参数通过真实 APISIX 校验');

  const du = await draft('upstreams', uid, 'create', {
    name: '集成验收上游',
    nodes: { 'echo:80': 1 },
    type: 'roundrobin',
  });
  createdDrafts.push(du.id);
  let dr = await draft('routes', rid, 'create', {
    name: '集成验收路由',
    uri: `/${prefix}/*`,
    upstream_id: uid,
    methods: ['GET'],
    labels: { future_extension: 'preserve-this' },
    plugins: {
      'proxy-rewrite': { headers: { set: { 'X-Integration-Token': 'private-initial-value' } } },
    },
  });
  createdDrafts.push(dr.id);
  assert.equal(
    dr.after.plugins['proxy-rewrite'].headers.set['X-Integration-Token'],
    '${dashboard:keep-secret}',
  );
  assert.equal((await gateway(`/routes/${rid}`)).status, 404);
  assert.equal((await gateway(`/upstreams/${uid}`)).status, 404);
  record('保存草稿不写入网关，草稿凭据脱敏');
  const oldRevision = dr.revision;
  dr.after.plugins['proxy-rewrite'].headers.set['X-Integration-Token'] = 'private-updated-value';
  dr = await updateDraft(dr, dr.after);
  dr.after.desc = '再次打开草稿后的普通字段编辑';
  const next = await updateDraft(dr, dr.after);
  await reject(updateDraft(dr, dr.after, oldRevision), 409);
  dr = next;
  record('草稿版本冲突检测，重复编辑保留新敏感值');

  assert.equal((await request(`/drafts/${dr.id}/validate`, 'POST', {})).ok, false);
  const created = await change([dr, du]);
  assert.equal((await request(`/changesets/${created.id}/validate`, 'POST', {})).ok, true);
  await reject(updateDraft(dr, dr.after), 409);
  const release = await publish(created);
  assert.equal(release.operations[0].resource_type, 'upstreams');
  assert.equal(
    (await gateway(`/routes/${rid}`)).data.value.plugins['proxy-rewrite'].headers.set[
      'X-Integration-Token'
    ],
    'private-updated-value',
  );
  assert.equal((await resource('routes', rid)).value.labels.future_extension, 'preserve-this');
  record('组合引用校验、内容冻结、依赖顺序发布与敏感值无损写入');
  assert.equal(
    (await request(`/changesets/${created.id}/publish`, 'POST', {})).status,
    'succeeded',
  );
  record('重复发布请求幂等');
  for (let i = 0; i < 30; i++) {
    if ((await fetch(`http://127.0.0.1:19080/${prefix}/hello`)).status === 200) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await fetch(`http://127.0.0.1:19080/${prefix}/hello`)).status, 200);
  record('真实数据面请求可转发到上游');

  const current = await resource('routes', rid);
  const edit = await draft(
    'routes',
    rid,
    'update',
    { ...current.value, desc: '待发布修改' },
    current.hash,
  );
  createdDrafts.push(edit.id);
  const conflict = await change([edit]);
  const {
    id: gatewayID,
    create_time,
    update_time,
    ...raw
  } = (await gateway(`/routes/${rid}`)).data.value;
  assert.equal((await gateway(`/routes/${rid}`, 'PUT', { ...raw, name: '外部修改' })).status, 200);
  assert.equal((await request(`/changesets/${conflict.id}/validate`, 'POST', {})).ok, false);
  await request(`/changesets/${conflict.id}/publish`, 'POST', {});
  assert.equal((await waitChange(conflict.id)).status, 'conflict');
  assert.equal((await gateway(`/routes/${rid}`)).data.value.name, '外部修改');
  const undo = await request(`/changesets/${created.id}/rollback`, 'POST', {});
  assert.equal((await request(`/changesets/${undo.id}/validate`, 'POST', {})).ok, false);
  assert.equal((await request(`/changesets/${created.id}/rollback`, 'POST', {})).id, undo.id);
  record('外部修改阻止发布与旧版本回退，回退请求幂等');
  assert.equal((await gateway(`/routes/${rid}`, 'PUT', raw)).status, 200);
  await request(`/changesets/${conflict.id}/cancel`, 'POST', {});

  const up = await resource('upstreams', uid);
  const deleteUp = await draft('upstreams', uid, 'delete', undefined, up.hash);
  createdDrafts.push(deleteUp.id);
  assert.equal((await request(`/drafts/${deleteUp.id}/validate`, 'POST', {})).ok, false);
  await request(`/drafts/${deleteUp.id}`, 'DELETE');
  record('阻止删除仍被引用的上游');

  const now = await resource('routes', rid);
  const remove = await draft('routes', rid, 'delete', undefined, now.hash);
  createdDrafts.push(remove.id);
  const deletion = await publish(await change([remove]));
  assert.equal((await gateway(`/routes/${rid}`)).status, 404);
  const restore = await request(`/changesets/${deletion.id}/rollback`, 'POST', {});
  assert.equal((await gateway(`/routes/${rid}`)).status, 404);
  await publish(restore);
  assert.equal((await gateway(`/routes/${rid}`)).data.value.name, raw.name);
  record('删除经发布生效，回退预览后重新创建原配置');

  const readonlyResource = await resource('routes', rid);
  const readonlyDraft = await draft(
    'routes',
    rid,
    'update',
    { ...readonlyResource.value, desc: '只读拦截测试' },
    readonlyResource.hash,
  );
  createdDrafts.push(readonlyDraft.id);
  const readonlyChange = await change([readonlyDraft]);
  await request(`/clusters/${cluster.id}`, 'PUT', { ...clusterBody, read_only: true });
  toggled = true;
  await reject(
    draft('upstreams', `${prefix}-readonly`, 'create', { nodes: { 'echo:80': 1 } }),
    403,
  );
  await reject(request(`/changesets/${readonlyChange.id}/publish`, 'POST', {}), 403);
  await request(`/clusters/${cluster.id}`, 'PUT', clusterBody);
  toggled = false;
  await request(`/changesets/${readonlyChange.id}/cancel`, 'POST', {});
  record('只读集群阻止新增草稿和发布已有变更');

  await publish(undo);
  assert.equal((await gateway(`/routes/${rid}`)).status, 404);
  assert.equal((await gateway(`/upstreams/${uid}`)).status, 404);
  record('原始批量发布可按路由、上游顺序完整回退');
  assert.ok(
    (await request('/audit')).some(
      (row) => row.target === created.id && row.action === 'change.succeeded',
    ),
  );
  record('发布结果已记录审计');
  console.log(
    `Integration: ${checks.length} checks passed against APISIX ${probe.version || 'unknown'} and PostgreSQL.`,
  );
} finally {
  if (toggled) await request(`/clusters/${cluster.id}`, 'PUT', clusterBody);
  // Only remove IDs generated by this run inside the dedicated local test gateway.
  await gateway(`/routes/${rid}`, 'DELETE');
  await gateway(`/upstreams/${uid}`, 'DELETE');
  for (const id of createdDrafts) {
    try {
      const d = await request(`/drafts/${id}`);
      if (d.status === 'draft') await request(`/drafts/${id}`, 'DELETE');
    } catch {
      /* Preserve the original test error. */
    }
  }
}

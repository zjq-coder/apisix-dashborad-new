import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';

const { request, gateway, waitChange } = await sandboxClient();
const cluster = (await request('/clusters')).find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
assert.ok(cluster && !cluster.read_only, 'A writable local sandbox is required');
const id = `consumer-check-${Date.now()}`;
const key = randomBytes(32).toString('hex');
const replacement = randomBytes(32).toString('hex');
const KEEP = '${dashboard:keep-secret}';
const path = `/clusters/${cluster.id}/resources/consumers/${id}`;
const checks = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
function redacted(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(key) && !text.includes(replacement), 'API response leaked a credential');
}
async function preview(value, extra = {}) {
  return request(`/clusters/${cluster.id}/validate`, 'POST', {
    resource_type: 'consumers',
    resource_id: id,
    value,
    ...extra,
  });
}
async function draft(action, value) {
  const current = action === 'create' ? undefined : await request(path);
  const d = await request('/drafts', 'POST', {
    cluster_id: cluster.id,
    resource_type: 'consumers',
    resource_id: id,
    action,
    value,
    base_hash: current?.hash,
    title: id,
  });
  redacted(d);
  return d;
}
async function release(d) {
  const change = await request('/changesets', 'POST', {
    draft_ids: [d.id],
    title: id,
    reason: '消费者与 API Key 本地集成验收',
  });
  assert.equal((await request(`/changesets/${change.id}/validate`, 'POST', {})).ok, true);
  await request(`/changesets/${change.id}/publish`, 'POST', {});
  const done = await waitChange(change.id);
  assert.equal(done.status, 'succeeded');
  redacted(done);
  return done;
}
async function traffic(expected, credential) {
  let status;
  for (let i = 0; i < 30; i++) {
    const response = await sandboxProxy(
      `/${id}`,
      credential === undefined ? {} : { headers: { apikey: credential } },
    );
    status = response.status;
    await response.text();
    if (status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status, expected);
}
async function rollback(change) {
  const back = await request(`/changesets/${change.id}/rollback`, 'POST', {});
  redacted(back);
  assert.equal((await request(`/changesets/${back.id}/validate`, 'POST', {})).ok, true);
  await request(`/changesets/${back.id}/publish`, 'POST', {});
  assert.equal((await waitChange(back.id)).status, 'succeeded');
}
try {
  assert.equal((await gateway(`/routes/${id}`)).status, 404);
  assert.ok(
    [200, 201].includes(
      (
        await gateway(`/routes/${id}`, 'PUT', {
          uri: `/${id}`,
          plugins: { 'key-auth': { hide_credentials: true } },
          upstream: { type: 'roundrobin', nodes: { 'echo:80': 1 } },
        })
      ).status,
    ),
  );
  await traffic(401);
  const value = { username: id, plugins: { 'key-auth': { key } } };
  await assert.rejects(
    preview({ ...value, username: `${id}-other` }),
    (error) => error.status === 400,
  );
  assert.equal((await preview({ username: id, plugins: { 'key-auth': {} } })).ok, false);
  assert.equal((await preview({ username: id, plugins: { 'key-auth': { key: '' } } })).ok, false);
  assert.equal((await preview(value)).ok, true);
  record('用户名绑定及消费者专属 Schema 校验');

  const created = await draft('create', value);
  assert.equal(created.after.plugins['key-auth'].key, KEEP);
  assert.equal((await gateway(`/consumers/${id}`)).status, 404);
  redacted(await request(`/drafts/${created.id}`));
  assert.equal((await request(`/drafts/${created.id}/validate`, 'POST', {})).ok, true);
  record('草稿保存不写网关，密钥和差异脱敏');
  await release(created);
  await traffic(401);
  await traffic(401, 'invalid-consumer-key');
  await traffic(200, key);
  record('发布后真实请求无密钥 401、错误密钥 401、有效密钥 200');

  const live = await request(path);
  redacted(live);
  assert.equal(live.id, id);
  const list = await request(`/clusters/${cluster.id}/resources/consumers`);
  redacted(list);
  assert.ok(
    list.items.some((item) => item.id === id && item.value.plugins['key-auth'].key === KEEP),
  );
  record('消费者列表与详情只返回密钥占位符');
  const duplicate = await request(`/clusters/${cluster.id}/validate`, 'POST', {
    resource_type: 'consumers',
    resource_id: `${id}-duplicate`,
    value: { ...value, username: `${id}-duplicate` },
  });
  assert.equal(duplicate.ok, false);
  redacted(duplicate);
  record('拒绝其他消费者重复密钥且错误信息不泄露密钥');

  await release(await draft('update', { ...live.value, desc: '保留原密钥的说明修改' }));
  await traffic(200, key);
  record('修改说明时保留原密钥');
  const toRotate = await draft('update', {
    ...(await request(path)).value,
    plugins: { 'key-auth': { key: replacement } },
  });
  assert.ok(toRotate.diff.some((d) => d.path === '/plugins/key-auth/key' && d.sensitive));
  await traffic(200, key);
  await traffic(401, replacement);
  const rotation = await release(toRotate);
  await traffic(401, key);
  await traffic(200, replacement);
  record('密钥轮换仅在发布后生效，旧密钥随即失效');
  await rollback(rotation);
  await traffic(200, key);
  await traffic(401, replacement);
  record('轮换回退恢复旧密钥');

  const current = await request(path);
  const conflicting = await draft('update', { ...current.value, desc: '冲突候选值' });
  const raw = await gateway(`/consumers/${id}`);
  const external = { ...raw.data.value, desc: '外部并发修改' };
  delete external.id;
  delete external.create_time;
  delete external.update_time;
  const externalWrite = await gateway('/consumers', 'PUT', external);
  assert.ok(
    [200, 201].includes(externalWrite.status),
    `External update fixture returned ${externalWrite.status}`,
  );
  assert.equal((await request(`/drafts/${conflicting.id}/validate`, 'POST', {})).ok, false);
  await request(`/drafts/${conflicting.id}`, 'DELETE');
  await traffic(200, key);
  record('消费者并发修改冲突检查');

  const deletion = await release(await draft('delete', null));
  await traffic(401, key);
  assert.equal((await gateway(`/consumers/${id}`)).status, 404);
  await rollback(deletion);
  await traffic(200, key);
  record('删除撤销认证及删除回退');
} finally {
  assert.ok([200, 404].includes((await gateway(`/routes/${id}`, 'DELETE')).status));
  assert.ok([200, 404].includes((await gateway(`/consumers/${id}`, 'DELETE')).status));
  for (const d of await request(`/drafts?cluster_id=${cluster.id}`))
    if (d.resource_id === id && d.status === 'draft') await request(`/drafts/${d.id}`, 'DELETE');
  assert.equal((await gateway(`/consumers/${id}`)).status, 404);
  await writeFile(
    '.local/consumer-integration.json',
    JSON.stringify(
      { at: new Date().toISOString(), checks, temporary_resources_removed: true },
      null,
      2,
    ) + '\n',
  );
}

// Exercises the real Dashboard, PostgreSQL and the two explicitly named local Docker sandboxes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sandboxClient, sandboxProxy } from './sandbox-client.mjs';
const admin = await sandboxClient(),
  base = 'http://127.0.0.1:18080/api/v1';
const clusters = await admin.request('/clusters');
const dev = clusters.find(
  (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
);
const stage = clusters.find(
  (c) => c.url === 'http://apisix-staging:9180/apisix/admin' && c.environment === 'staging',
);
assert.ok(
  dev && stage && !dev.read_only && !stage.read_only,
  'Start both writable local sandboxes before running the access suite.',
);
const prefix = 'p0-' + randomBytes(5).toString('hex'),
  pw = () => randomBytes(22).toString('base64url');
const salt = pw(),
  immutableSecrets = [salt, admin.config.APISIX_ADMIN_KEY, admin.config.DASHBOARD_PASSWORD];
let count = 0;
const record = (name) => {
  console.log('PASS ' + name);
  count++;
};
const masked = (value) => {
  const text = JSON.stringify(value);
  for (const secret of immutableSecrets)
    assert.ok(!text.includes(secret), 'A protected value appeared in a public response');
  assert.ok(!text.includes('password_hash'), 'Account hashes must be private');
};
async function call(session, path, method = 'GET', body, options = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...options,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  masked(data);
  return { status: response.status, data, headers: response.headers };
}
async function status(session, path, code, method, body, headers) {
  const r = await call(session, path, method, body, headers);
  assert.equal(r.status, code, (method || 'GET') + ' ' + path + ' (' + r.status + ')');
  return r.data;
}
const adm = { cookie: admin.cookie, csrf: admin.session.csrf_token };
const accounts = [],
  drafts = [],
  changes = [];
const route = prefix + '-route',
  foreign = prefix + '-foreign',
  uri = '/' + route;
async function create(suffix, grants) {
  const username = prefix + '-' + suffix,
    password = pw();
  immutableSecrets.push(password);
  const a = await status(adm, '/users', 201, 'POST', {
    username,
    password,
    role: 'member',
    enabled: true,
    grants,
  });
  accounts.push(username);
  return { ...a, password };
}
async function login(a, expected = 200) {
  const result = await call(null, '/login', 'POST', { username: a.username, password: a.password });
  assert.equal(result.status, expected, 'sign-in outcome');
  if (expected !== 200) return;
  const c = result.headers.get('set-cookie');
  assert.match(c, /HttpOnly/i);
  assert.match(c, /SameSite=Strict/i);
  return { cookie: c.split(';')[0], csrf: result.data.csrf_token };
}
const body = (c, id, canary = false) => ({
  cluster_id: c.id,
  resource_type: 'routes',
  resource_id: id,
  action: 'create',
  value: {
    uri: '/' + id,
    upstream: { type: 'roundrobin', nodes: { [c === dev ? 'echo:80' : 'echo-staging:80']: 1 } },
    ...(canary
      ? { plugins: { 'proxy-rewrite': { headers: { set: { 'X-Test-Token': salt } } } } }
      : {}),
  },
});
async function makeDraft(session, c, id, canary = false) {
  const d = await status(session, '/drafts', 200, 'POST', body(c, id, canary));
  drafts.push(d.id);
  return d;
}
const changeBody = (ids) => ({
  draft_ids: ids,
  title: prefix,
  reason: 'P0 local access verification',
});
async function makeChange(s, ids) {
  const c = await status(s, '/changesets', 201, 'POST', changeBody(ids));
  changes.push(c.id);
  return c;
}
async function proxy(expected) {
  let last;
  for (let i = 0; i < 35; i++) {
    last = (await sandboxProxy(uri)).status;
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(last, expected, 'local business route result');
}
try {
  const viewer = await create('viewer', { [dev.id]: [] });
  const editor = await create('editor', { [dev.id]: ['edit'], [stage.id]: [] });
  const publisher = await create('publisher', { [dev.id]: ['publish'] });
  const rollback = await create('rollback', { [dev.id]: ['rollback'] });
  const auditor = await create('auditor', { [dev.id]: ['audit'] });
  const none = await create('none', {});
  const V = await login(viewer),
    E = await login(editor),
    P = await login(publisher),
    R = await login(rollback),
    A = await login(auditor),
    N = await login(none);
  await status(null, '/clusters', 401);
  await status(V, '/users', 403);
  await status(V, '/users', 403, 'POST', {});
  await status(E, '/clusters', 403, 'POST', {});
  await status(E, '/clusters/' + dev.id + '/probe', 403, 'POST', {});
  await status(V, '/clusters/' + dev.id, 403, 'PUT', {});
  await status(V, '/drafts', 403, 'POST', body(dev, route), { 'X-CSRF-Token': '' });
  await login({ ...viewer, password: pw() }, 401);
  assert.equal((await status(E, '/session', 200)).role, 'member');
  assert.equal(
    (await status(adm, '/users', 200)).find((a) => a.username === admin.session.username).bootstrap,
    true,
  );
  record('账号登录、错误密码、CSRF、管理员专属操作及敏感凭据不回显');
  assert.deepEqual(
    (await status(V, '/clusters', 200)).map((c) => c.id),
    [dev.id],
  );
  assert.deepEqual(await status(N, '/clusters', 200), []);
  assert.deepEqual(await status(N, '/drafts', 200), []);
  assert.deepEqual(await status(N, '/changesets', 200), []);
  for (const part of [
    'workspace',
    'resources/routes',
    'plugins',
    'plugins/catalog',
    'plugins/key-auth/schema',
  ])
    await status(V, '/clusters/' + stage.id + '/' + part, 404);
  await status(V, '/clusters/' + dev.id + '/workspace', 200);
  await status(V, '/clusters/' + dev.id + '/resources/routes', 200);
  await status(E, '/clusters/' + stage.id + '/workspace', 200);
  await status(E, '/drafts', 403, 'POST', body(stage, foreign));
  const manifest = {
    format: 'apisix-dashboard/v1',
    items: [{ kind: 'upstreams', id: prefix, value: { nodes: { 'echo:80': 1 } } }],
  };
  const preview = await status(V, '/clusters/' + dev.id + '/transfer/preview', 200, 'POST', {
    bundle: manifest,
  });
  await status(V, '/clusters/' + dev.id + '/transfer/stage', 403, 'POST', {
    bundle: manifest,
    token: preview.token,
  });
  await status(V, '/clusters/' + stage.id + '/export', 404, 'POST', {
    roots: [{ kind: 'routes', id: route }],
  });
  await status(V, '/clusters/' + stage.id + '/transfer/preview', 404, 'POST', { bundle: manifest });
  record('集群白名单、未分配账号、按环境读写隔离和多环境列表');
  const sd = await makeDraft(adm, stage, foreign);
  const sc = await makeChange(adm, [sd.id]);
  const d = await makeDraft(E, dev, route, true);
  assert.equal(
    d.after.plugins['proxy-rewrite'].headers.set['X-Test-Token'],
    '${dashboard:keep-secret}',
  );
  for (const p of [
    '/drafts/' + sd.id,
    '/changesets/' + sc.id,
    '/drafts?cluster_id=' + stage.id,
    '/changesets?cluster_id=' + stage.id,
  ])
    await status(V, p, 404);
  await status(V, '/drafts/' + sd.id + '/validate', 404, 'POST', {});
  await status(P, '/changesets/' + sc.id + '/publish', 404, 'POST', {});
  await status(E, '/changesets', 403, 'POST', changeBody([d.id, sd.id]));
  await status(V, '/clusters/' + dev.id + '/validate', 404, 'POST', {
    resource_type: 'routes',
    resource_id: foreign,
    value: { uri: '/test' },
    draft_id: sd.id,
  });
  await status(V, '/clusters/' + dev.id + '/plugins/key-auth/validate', 404, 'POST', {
    value: {},
    draft_id: sd.id,
  });
  await status(V, '/drafts/' + d.id, 403, 'DELETE');
  await status(V, '/drafts/' + d.id, 403, 'PUT', body(dev, route));
  await status(V, '/drafts', 403, 'POST', body(dev, route));
  assert.equal((await status(E, '/drafts/' + d.id, 200)).status, 'draft');
  assert.ok((await status(V, '/drafts', 200)).every((x) => x.cluster_id === dev.id));
  assert.ok((await status(V, '/changesets', 200)).every((x) => x.cluster_id === dev.id));
  await status(E, '/drafts/' + d.id, 200, 'PUT', {
    ...body(dev, route),
    value: d.after,
    revision: d.revision,
  });
  await proxy(404);
  record('跨集群详情、混合草稿、校验引用与只读账号写入均受控；草稿未写入网关');
  const c = await makeChange(E, [d.id]);
  const path = '/changesets/' + c.id;
  for (const s of [V, E, R, A]) await status(s, path + '/publish', 403, 'POST', {});
  await status(E, path + '/cancel', 403, 'POST', {});
  await status(R, path + '/reconcile', 403, 'POST', {});
  await status(P, '/drafts', 403, 'POST', body(dev, route));
  await status(P, path + '/publish', 202, 'POST', {});
  assert.equal((await admin.waitChange(c.id)).status, 'succeeded');
  await status(V, path, 200);
  const live = await status(V, '/clusters/' + dev.id + '/resources/routes/' + route, 200);
  assert.equal(
    live.value.plugins['proxy-rewrite'].headers.set['X-Test-Token'],
    '${dashboard:keep-secret}',
  );
  await proxy(200);
  record('编辑者提交、独立发布者执行，真实路由由 404 变为 200，线上配置和变更详情脱敏');
  await status(P, path + '/rollback', 403, 'POST', {});
  const back = await status(R, path + '/rollback', 201, 'POST', {});
  changes.push(back.id);
  assert.equal(back.rollback_of, c.id);
  for (const op of ['publish', 'cancel', 'reconcile'])
    await status(P, '/changesets/' + back.id + '/' + op, 403, 'POST', {});
  await status(R, '/changesets/' + back.id + '/publish', 202, 'POST', {});
  assert.equal((await admin.waitChange(back.id)).status, 'succeeded');
  await proxy(404);
  record('单独授权回退者可生成并执行回退，普通发布者不能代为执行；真实路由恢复 404');
  const events = await status(A, '/audit', 200);
  assert.ok(events.length > 0 && events.every((x) => x.cluster_id === dev.id));
  assert.ok(!events.some((x) => ['login', 'account.create'].includes(x.action)));
  for (const [id, actor] of [
    [c.id, publisher.username],
    [back.id, rollback.username],
  ]) {
    const rows = await status(
      A,
      '/audit?actor=' + actor + '&action=change.succeeded&outcome=success&cluster_id=' + dev.id,
      200,
    );
    assert.ok(rows.some((x) => x.target === id && x.actor === actor));
  }
  await status(V, '/audit', 403);
  await status(A, '/audit?cluster_id=' + stage.id, 404);
  const security = await status(adm, '/audit?actor=' + viewer.username + '&outcome=denied', 200);
  assert.ok(security.some((x) => x.action === 'login' && x.http_status === 401));
  assert.ok(security.some((x) => x.action === 'draft.discard' && x.http_status === 403));
  const page1 = await status(A, '/audit?limit=2', 200),
    page2 = await status(A, '/audit?limit=2&before_id=' + page1.at(-1).id, 200);
  assert.ok(page1.length === 2 && page2.every((x) => x.id < page1.at(-1).id));
  await status(A, '/audit?limit=0', 400);
  record('审计按集群隔离，过滤与游标翻页；登录失败、拒绝结果、真实发布人和回退人可追溯');
  const updated = {
    username: viewer.username,
    role: 'member',
    enabled: true,
    revision: viewer.revision,
    grants: { [stage.id]: [] },
    password: pw(),
  };
  immutableSecrets.push(updated.password);
  const u = await status(adm, '/users/' + viewer.username, 200, 'PUT', updated);
  await status(V, '/session', 401);
  await status(adm, '/users/' + viewer.username, 409, 'PUT', updated);
  await login(viewer, 401);
  const v2 = await login({ ...viewer, password: updated.password });
  assert.deepEqual(
    (await status(v2, '/clusters', 200)).map((x) => x.id),
    [stage.id],
  );
  await status(v2, '/clusters/' + dev.id + '/workspace', 404);
  await status(adm, '/users/' + viewer.username, 200, 'PUT', {
    ...updated,
    password: '',
    enabled: false,
    revision: u.revision,
  });
  await status(v2, '/clusters', 401);
  await login({ ...viewer, password: updated.password }, 401);
  await status(adm, '/users/' + admin.session.username, 403, 'DELETE', { revision: 1 });
  await status(adm, '/users/' + admin.session.username, 403, 'PUT', {
    ...updated,
    username: admin.session.username,
  });
  const created = await status(adm, '/audit?action=account.update&outcome=success', 200);
  assert.ok(
    created.some((x) => x.target === viewer.username && JSON.parse(x.detail).password_changed),
  );
  await status(E, '/logout', 200, 'POST', {});
  await status(E, '/clusters', 401);
  record('密码轮换、集群换权、停用和退出即时撤销旧会话；版本冲突与部署管理员保护');
  const promoted = await status(adm, '/users/' + none.username, 200, 'PUT', {
    username: none.username,
    role: 'administrator',
    enabled: true,
    grants: {},
    revision: none.revision,
  });
  await status(N, '/session', 401);
  const secondAdmin = await login(none);
  await status(secondAdmin, '/users', 200);
  assert.ok((await status(secondAdmin, '/clusters', 200)).some((c) => c.id === stage.id));
  await status(secondAdmin, '/users/' + none.username, 403, 'DELETE', {
    revision: promoted.revision,
  });
  await status(adm, '/users/' + none.username, 200, 'DELETE', { revision: promoted.revision });
  await status(secondAdmin, '/clusters', 401);
  await login(none, 401);
  record('管理员角色变更与删除生效，已有会话不可继续使用，不能删除自身');
} finally {
  for (const id of changes.reverse()) {
    const c = await admin.request('/changesets/' + id);
    if (c.status === 'pending') await admin.request('/changesets/' + id + '/cancel', 'POST', {});
  }
  for (const id of drafts) {
    const d = await admin.request('/drafts/' + id);
    if (d.status === 'draft') await admin.request('/drafts/' + id, 'DELETE');
  }
  const current = await admin.gateway('/routes/' + route);
  if (current.status === 200) await admin.gateway('/routes/' + route, 'DELETE');
  for (const a of (await admin.request('/users')).filter((x) => accounts.includes(x.username)))
    await admin.request('/users/' + a.username, 'DELETE', { revision: a.revision });
  assert.ok(!(await admin.request('/users')).some((a) => accounts.includes(a.username)));
}
console.log(
  'Access integration: ' +
    count +
    ' scenario groups passed; test accounts and gateway route removed.',
);

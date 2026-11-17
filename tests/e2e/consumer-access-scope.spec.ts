import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { sandboxClient, sandboxProxy } from '../../scripts/sandbox-client.mjs';
import type { Change, Cluster } from '../../web/src/types';

const ns = 'scope-' + randomBytes(5).toString('hex');
const key = () => randomBytes(24).toString('hex');
const route = (suffix: string) => ns + '-' + suffix;
const path = (suffix: string) => '/' + ns + '/' + suffix;
const upstream = { type: 'roundrobin', nodes: { 'echo:80': 1 } };
const auth = { 'multi-auth': { auth_plugins: [{ 'key-auth': {} }, { 'basic-auth': {} }] } };
const identityHeader = {
  'response-rewrite': { headers: { set: { 'X-Scope-Identity': '$consumer_name' } } },
};
const removals: string[] = [];
let client: Awaited<ReturnType<typeof sandboxClient>>, cluster: Cluster;
const apiRoot = () => '/clusters/' + cluster.id;

async function fixture(resource: string, value: object) {
  expect((await client.gateway(resource)).status).toBe(404);
  removals.push(resource);
  expect((await client.gateway(resource, 'PUT', value)).status, resource).toBeLessThan(300);
}
test.beforeAll(async () => {
  client = await sandboxClient();
  cluster = (await client.request('/clusters')).find(
    (c: Cluster) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  );
  expect(cluster && !cluster.read_only).toBeTruthy();
  await mkdir('.local/screenshots', { recursive: true });
  for (const s of ['orders', 'billing'])
    await fixture('/services/' + route(s), { name: s, upstream, plugins: auth });
  for (const [suffix, service] of [
    ['list', 'orders'],
    ['detail', 'orders'],
    ['invoice', 'billing'],
  ])
    await fixture('/routes/' + route(suffix), {
      uri: path(suffix),
      name: suffix,
      service_id: route(service),
      plugins: identityHeader,
    });
  for (const [suffix, plugins] of [
    ['solo', { 'key-auth': {}, ...identityHeader }],
    ['public', {}],
  ] as const)
    await fixture('/routes/' + route(suffix), {
      uri: path(suffix),
      name: suffix,
      upstream,
      plugins,
    });
});
test.afterAll(async () => {
  // Credentials are removed before their consumer, and routes before their services.
  for (const resource of removals.reverse()) {
    const deleted = await client.gateway(resource, 'DELETE');
    expect([200, 204, 404], resource).toContain(deleted.status);
    expect((await client.gateway(resource)).status, resource).toBe(404);
  }
});
async function open(page: Page, location: string) {
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto(location + (location.includes('?') ? '&' : '?') + 'cluster=' + cluster.id);
}
async function traffic(
  suffix: string,
  headers: Record<string, string>,
  status: number,
  identity?: string,
  reason?: string,
) {
  await expect
    .poll(
      async () => {
        const res = await sandboxProxy(path(suffix), { headers });
        const body = await res.text();
        return {
          status: res.status,
          expectedBody:
            status === 200
              ? body.includes('dashboard-sandbox')
              : !body.includes('dashboard-sandbox') && (!reason || body.includes(reason)),
          identity: identity ? res.headers.get('x-scope-identity') : null,
        };
      },
      { message: suffix + ' expects HTTP ' + status },
    )
    .toEqual({ status, expectedBody: true, identity: identity || null });
}
async function choose(page: Page, selector: Locator, id: string) {
  await selector.fill(id);
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: id })
    .click();
  await selector.press('Escape');
  await selector.blur();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
}
async function mode(page: Page, label: string) {
  const radio = page.getByRole('radio', { name: label, exact: true });
  await expect(radio).toBeEnabled();
  await page.locator('label.ant-radio-button-wrapper').filter({ has: radio }).click();
  await expect(radio).toBeChecked();
}
async function write(page: Page, button: Locator, endpoint: string): Promise<Change> {
  const event = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(endpoint),
  );
  await button.click();
  const response = await event;
  expect(response.status()).toBe(201);
  const change = await client.waitChange((await response.json()).id);
  expect(change.status, change.operations.map((op: { error: string }) => op.error).join(' ')).toBe(
    'succeeded',
  );
  return change;
}
async function rollback(change: Change) {
  const undo = await client.request('/changesets/' + change.id + '/rollback', 'POST', {});
  await client.request('/changesets/' + undo.id + '/publish', 'POST', {});
  const result = await client.waitChange(undo.id);
  expect(result.status).toBe('succeeded');
  return result;
}

test('消费者白名单按路由或服务放行，支持清除和回退', async ({ page }) => {
  test.setTimeout(120_000);
  const who = route('caller'),
    peer = route('peer');
  const token = key(),
    peerToken = key(),
    password = key();
  const apiKey = { apikey: token },
    basic = { Authorization: 'Basic ' + Buffer.from(who + ':' + password).toString('base64') };
  await fixture('/consumers/' + who, {
    username: who,
    plugins: { 'key-auth': { key: token }, 'basic-auth': { username: who, password } },
  });
  await fixture('/consumers/' + peer, {
    username: peer,
    plugins: { 'key-auth': { key: peerToken } },
  });
  const edit = () => open(page, '/consumers/' + who + '/edit');
  const save = page.getByRole('button', { name: '保存并发布', exact: true }).first();
  await traffic('invoice', apiKey, 200, who);
  await edit();
  await mode(page, '指定路由');
  await save.click();
  await expect(page.getByText('请选择允许访问的路由或服务').first()).toBeVisible();
  expect(
    (await client.gateway('/consumers/' + who)).data.value.plugins['consumer-restriction'],
  ).toBeUndefined();
  const routes = page.getByRole('combobox', { name: '允许访问的路由' });
  for (const id of ['list', 'invoice']) await choose(page, routes, route(id));
  await page
    .locator('.consumer-scope')
    .evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page
    .locator('.consumer-scope')
    .locator('..')
    .screenshot({ path: '.local/screenshots/consumer-access-scope.png' });
  const listed = await write(page, save, '/config/apply');
  expect(listed.operations![0].after!.plugins['consumer-restriction'].whitelist).toEqual([
    route('list'),
    route('invoice'),
  ]);
  await traffic('list', apiKey, 200, who);
  await traffic('invoice', basic, 200, who);
  await traffic('detail', apiKey, 403, undefined, 'route_id');
  await traffic('detail', basic, 403);
  await traffic('detail', { apikey: peerToken }, 200, peer);
  await traffic('list', {}, 401);
  await traffic('list', { apikey: 'invalid' }, 401);
  await traffic('public', {}, 200);
  await edit();
  await mode(page, '指定服务');
  await expect(page.getByText('已选 0 项')).toBeVisible();
  await choose(page, page.getByRole('combobox', { name: '允许访问的服务' }), route('orders'));
  const serviceChange = await write(page, save, '/config/apply');
  await traffic('list', apiKey, 200, who);
  await traffic('detail', basic, 200, who);
  await traffic('invoice', apiKey, 403, undefined, 'service_id');
  await traffic('solo', apiKey, 401, undefined, 'service_id');
  await fixture('/routes/' + route('later'), {
    uri: path('later'),
    service_id: route('orders'),
    plugins: identityHeader,
  });
  await traffic('later', apiKey, 200, who);
  await edit();
  await mode(page, '不额外限制');
  const cleared = await write(page, save, '/config/apply');
  await traffic('invoice', apiKey, 200, who);
  await rollback(cleared);
  await traffic('invoice', apiKey, 403);
  await rollback(serviceChange);
  await traffic('invoice', basic, 200, who);
  await traffic('detail', basic, 403);
});

test('仅迁移一个认证方式，保留原密钥、策略、其他认证和独立 Credential', async ({ page }) => {
  test.setTimeout(120_000);
  const who = route('mixed'),
    scoped = who + '-key',
    group = route('group');
  const token = key(),
    password = key(),
    second = key();
  const apiKey = { apikey: token },
    basic = { Authorization: 'Basic ' + Buffer.from(who + ':' + password).toString('base64') };
  await fixture('/consumer_groups/' + group, { plugins: { 'request-id': {} } });
  await fixture('/consumers/' + who, {
    username: who,
    group_id: group,
    labels: { team: 'scope-test' },
    plugins: {
      'key-auth': { key: token },
      'basic-auth': { username: who, password },
      'limit-count': { count: 1000, time_window: 60, key: 'remote_addr', policy: 'local' },
    },
  });
  await fixture('/consumers/' + who + '/credentials/second', {
    plugins: { 'key-auth': { key: second } },
  });
  removals.push('/consumers/' + scoped);
  await traffic('invoice', apiKey, 200, who);
  await traffic('invoice', { apikey: second }, 200, who);
  await open(page, '/consumers/' + who + '/edit');
  await page.getByRole('button', { name: '单独授权 key-auth', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '单独授权认证方式' });
  await dialog.getByLabel('独立消费者用户名').fill(scoped);
  const save = dialog.getByRole('button', { name: '保存并发布' });
  await expect(save).toBeDisabled();
  await choose(page, dialog.getByRole('combobox', { name: '允许访问的路由' }), route('list'));
  await dialog.screenshot({ path: '.local/screenshots/scope-one-credential.png' });
  const change = await write(page, save, '/scope-credential/apply');
  await expect(page).toHaveURL(new RegExp('/consumers/' + scoped + '/edit'));
  const live = (await client.gateway('/consumers/' + scoped)).data.value;
  expect(live.group_id).toBe(group);
  expect(live.labels.team).toBe('scope-test');
  expect(live.plugins['limit-count'].count).toBe(1000);
  expect(live.plugins['basic-auth']).toBeUndefined();
  for (const secret of [token, password, second])
    expect(JSON.stringify(change).includes(secret)).toBe(false);
  expect(change.operations!.map((op) => [op.resource_id, op.action])).toEqual([
    [who, 'update'],
    [scoped, 'create'],
  ]);
  await traffic('list', apiKey, 200, scoped);
  await traffic('invoice', apiKey, 403, undefined, 'route_id');
  await traffic(
    'invoice',
    { ...apiKey, 'X-Consumer-Username': who, 'X-Credential-Identifier': 'second' },
    403,
  );
  await traffic('invoice', basic, 200, who);
  await traffic('invoice', { apikey: second }, 200, who);
  const undo = await rollback(change);
  expect(undo.operations.map((op: { resource_id: string }) => op.resource_id)).toEqual([
    scoped,
    who,
  ]);
  expect((await client.gateway('/consumers/' + scoped)).status).toBe(404);
  await traffic('invoice', apiKey, 200, who);
  await traffic('invoice', basic, 200, who);
});

test('高级访问规则、拒绝响应和已有网关策略的优先级', async ({ page }) => {
  const who = route('advanced'),
    token = key(),
    resource = '/consumers/' + who;
  const rule = {
    type: 'route_id',
    whitelist: [route('list'), route('acl')],
    blacklist: [route('detail')],
    rejected_code: 451,
    rejected_msg: 'fixture-scope-denied',
  };
  await fixture('/routes/' + route('acl'), {
    uri: path('acl'),
    service_id: route('orders'),
    plugins: {
      ...identityHeader,
      'consumer-restriction': { type: 'consumer_name', whitelist: ['another-consumer'] },
    },
  });
  await fixture(resource, {
    username: who,
    plugins: { 'key-auth': { key: token }, 'consumer-restriction': rule },
  });
  await open(page, resource + '/edit');
  await expect(page.getByText('当前使用高级访问策略')).toBeVisible();
  await expect(page.getByRole('radio', { name: '指定路由' })).toHaveCount(0);
  const current = (await client.gateway(resource)).data.value.plugins['consumer-restriction'];
  await page.getByLabel('资源说明', { exact: true }).fill('preserve advanced scope');
  await expect(page.getByRole('button', { name: '单独授权 key-auth', exact: true })).toBeDisabled();
  await write(
    page,
    page.getByRole('button', { name: '保存并发布', exact: true }).first(),
    '/config/apply',
  );
  expect((await client.gateway(resource)).data.value.plugins['consumer-restriction']).toEqual(
    current,
  );
  await traffic('list', { apikey: token }, 200, who);
  await traffic('detail', { apikey: token }, 451, undefined, 'fixture-scope-denied');
  await traffic('acl', { apikey: token }, 200, who);
});

test('从现有路由和服务发起授权，预选当前资源并通过浏览器发布新凭据', async ({ page }) => {
  test.setTimeout(120_000);
  const who = route('new'),
    token = key();
  await open(page, '/routes/' + route('solo') + '/edit');
  await page.getByRole('tab', { name: '插件配置' }).click();
  await page.getByRole('button', { name: '编辑插件 key-auth', exact: true }).click();
  const link = page.getByRole('link', { name: '创建限定当前资源的凭据' });
  await expect(link).toHaveAttribute(
    'href',
    '/consumers/new?cluster=' +
      cluster.id +
      '&plugin=key-auth&scope=route_id&target=' +
      route('solo'),
  );
  const opened = page.waitForEvent('popup');
  await link.click();
  const editor = await opened;
  await editor.getByRole('dialog').getByLabel('key', { exact: true }).fill(token);
  await editor.getByRole('button', { name: '应用到消费者' }).click();
  await expect(editor.getByRole('radio', { name: '指定路由' })).toBeChecked();
  await editor.getByLabel('消费者用户名', { exact: true }).fill(who);
  removals.push('/consumers/' + who);
  await write(
    editor,
    editor.getByRole('button', { name: '保存并发布', exact: true }).first(),
    '/config/apply',
  );
  await traffic('solo', { apikey: token }, 200, who);
  await traffic('list', { apikey: token }, 403);
  await editor.close();

  await open(page, '/extended?kind=services');
  await page.getByPlaceholder('搜索资源 ID 或名称').fill(route('orders'));
  await page
    .getByRole('row')
    .filter({ hasText: route('orders') })
    .getByRole('button', { name: '编辑' })
    .click();
  await page.getByRole('tab', { name: '插件配置' }).click();
  await page.getByRole('button', { name: '添加插件', exact: true }).click();
  await page.getByPlaceholder('搜索插件名称或用途').fill('key-auth');
  await page
    .locator('.plugin-picker button')
    .filter({ has: page.locator('code').getByText('key-auth', { exact: true }) })
    .click();
  await expect(link).toHaveAttribute(
    'href',
    '/consumers/new?cluster=' +
      cluster.id +
      '&plugin=key-auth&scope=service_id&target=' +
      route('orders'),
  );
  const openedService = page.waitForEvent('popup');
  await link.click();
  const serviceEditor = await openedService;
  await serviceEditor
    .getByRole('dialog')
    .getByRole('button', { name: /^取\s*消$/ })
    .click();
  await expect(serviceEditor.getByRole('radio', { name: '指定服务' })).toBeChecked();
  await serviceEditor
    .locator('#root')
    .getByRole('button', { name: '切换语言', exact: true })
    .click();
  await serviceEditor.getByRole('menuitem', { name: 'English', exact: true }).click();
  await expect(
    serviceEditor.getByRole('heading', { name: 'Authentication access scope' }),
  ).toBeVisible();
  await serviceEditor.setViewportSize({ width: 390, height: 844 });
  const scope = serviceEditor.locator('.consumer-scope');
  await expect(scope).toContainText('1 selected');
  await scope.scrollIntoViewIfNeeded();
  expect(await scope.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await scope.locator('..').screenshot({ path: '.local/screenshots/consumer-scope-mobile-en.png' });
  await serviceEditor.close();
});

test('授权拒绝无效目标、过期基线与重放，编辑员仅能提交', async ({ page }) => {
  const who = route('guard'),
    to = route('guard-basic'),
    accountName = route('editor'),
    password = key(),
    token = key();
  const resource = '/consumers/' + who;
  await fixture(resource, {
    username: who,
    plugins: { 'key-auth': { key: token }, 'basic-auth': { username: who, password } },
  });
  const source = await client.request(apiRoot() + '/resources' + resource);
  const endpoint = apiRoot() + resource + '/scope-credential/';
  const body = {
    base_hash: source.hash,
    username: to,
    plugin: 'basic-auth',
    type: 'service_id',
    whitelist: [route('orders')],
  };
  for (const [patch, status] of [
    [{ whitelist: [] }, 400],
    [{ whitelist: [route('orders'), route('orders')] }, 400],
    [{ whitelist: [route('missing')] }, 409],
    [{ base_hash: 'stale' }, 409],
    [{ type: 'consumer_name' }, 400],
    [{ plugin: 'consumer-restriction' }, 400],
    [{ username: who }, 400],
  ] as const)
    await expect(
      client.request(endpoint + 'apply', 'POST', { ...body, ...patch }),
    ).rejects.toMatchObject({ status });
  expect((await client.gateway('/consumers/' + to)).status).toBe(404);
  const account = await client.request('/users', 'POST', {
    username: accountName,
    password,
    role: 'member',
    enabled: true,
    grants: { [cluster.id]: ['edit'] },
  });
  try {
    const login = await page.request.post('/api/v1/login', {
      data: { username: accountName, password },
    });
    expect(login.ok()).toBe(true);
    const headers = { 'X-CSRF-Token': (await login.json()).csrf_token };
    expect(
      (await page.request.post('/api/v1' + endpoint + 'apply', { headers, data: body })).status(),
    ).toBe(403);
    const submission = await page.request.post('/api/v1' + endpoint + 'submit', {
      headers,
      data: body,
    });
    expect(submission.status()).toBe(201);
    const pending = await submission.json();
    expect(pending.status).toBe('pending');
    expect((await client.gateway('/consumers/' + to)).status).toBe(404);
    expect(
      (
        await page.request.post('/api/v1/changesets/' + pending.id + '/publish', {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(403);
    removals.push('/consumers/' + to);
    await client.request('/changesets/' + pending.id + '/publish', 'POST', {});
    const published = await client.waitChange(pending.id);
    expect(published.status).toBe('succeeded');
    const basic = {
      Authorization: 'Basic ' + Buffer.from(who + ':' + password).toString('base64'),
    };
    await traffic('list', basic, 200, to);
    await traffic('invoice', basic, 403);
    await traffic('invoice', { apikey: token }, 200, who);
    await expect(client.request(endpoint + 'apply', 'POST', body)).rejects.toMatchObject({
      status: 409,
    });
    await rollback(published);
    await traffic('invoice', basic, 200, who);
  } finally {
    await client.request('/users/' + accountName, 'DELETE', { revision: account.revision });
  }
});

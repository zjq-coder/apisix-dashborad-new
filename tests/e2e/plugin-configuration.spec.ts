import { expect, test } from '@playwright/test';
import { sandboxClient, sandboxProxy } from '../../scripts/sandbox-client.mjs';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
const nodeOrStreamPlugins = new Set([
  'gm',
  'ocsp-stapling',
  'inspect',
  'log-rotate',
  'server-info',
  'error-log-logger',
  'batch-requests',
  'node-status',
  'mqtt-proxy',
]);

test('每个可配置插件在真实路由表单展示当前网关字段，保留字段类型与官方说明', async ({ page }) => {
  test.setTimeout(480_000);
  const { request, cookie } = await sandboxClient();
  const cluster = (await request('/clusters')).find(
    (x: { environment: string; url: string }) =>
      x.environment === 'development' && x.url === 'http://apisix:9180/apisix/admin',
  );
  const catalog = await request('/clusters/' + cluster.id + '/plugins/catalog');
  const [name, value] = cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto('/routes/new?cluster=' + cluster.id);
  await page.getByRole('tab', { name: '插件配置' }).click();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  for (const plugin of catalog.filter(
    (p: { scope: string; name: string }) =>
      p.scope !== 'global' && !nodeOrStreamPlugins.has(p.name),
  )) {
    await test.step(plugin.name, async () => {
      await page.getByRole('button', { name: '添加插件', exact: true }).click();
      await page.getByPlaceholder('搜索插件名称或用途').fill(plugin.name);
      await page
        .locator('.plugin-picker button')
        .filter({ has: page.getByText(plugin.name, { exact: true }) })
        .click();
      const dialog = page.locator('.plugin-config-dialog');
      const filter = dialog.getByRole('textbox', { name: '查找配置项' });
      const schema = await request(
        '/clusters/' + cluster.id + '/plugins/' + plugin.name + '/schema?scope=route',
      );
      const properties = Object.keys(schema.properties || {}).filter((k) => k !== '_meta');
      await expect(dialog.locator('.schema-fields').first()).toBeVisible();
      const actual = await dialog
        .locator('[data-plugin-label]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-plugin-label')));
      expect(actual, plugin.name).toEqual(expect.arrayContaining(properties));
      if (plugin.name === 'ai-cache')
        await expect(dialog.locator('[data-plugin-label="redis_host"]')).toBeVisible();
      if (plugin.name === 'limit-count') {
        await filter.fill('time_window');
        await expect(dialog.getByLabel('time_window', { exact: true })).toBeVisible();
        await expect(dialog.getByLabel('time_window 的值类型')).toBeVisible();
        await filter.fill('');
        await mkdir('.local/screenshots', { recursive: true });
        await dialog.screenshot({ path: '.local/screenshots/plugin-configuration.png' });
      }
      await page.keyboard.press('Escape');
    });
  }
  await page.locator('#root').getByRole('button', { name: '切换语言', exact: true }).click();
  await page.getByRole('menuitem', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Add plugin', exact: true }).click();
  await page.getByPlaceholder('Search plugins by name or purpose').fill('key-auth');
  await page
    .locator('.plugin-picker button')
    .filter({ has: page.getByText('key-auth', { exact: true }) })
    .click();
  await expect(page.locator('.plugin-config-dialog')).toContainText(
    'The header to get the key from.',
  );
  expect(errors).toEqual([]);
});

test('从插件表单发布限流规则并在真实订单接口验证', async ({ page }) => {
  const { request, gateway, cookie, waitChange } = await sandboxClient();
  const cluster = (await request('/clusters')).find(
    (c: { environment: string; url: string }) =>
      c.environment === 'development' && c.url === 'http://apisix:9180/apisix/admin',
  );
  const id = 'ui-limit-' + randomBytes(6).toString('hex');
  const resource = '/routes/' + id,
    uri = '/api/orders/' + id,
    host = id + '.example.test';
  const source = (await gateway('/routes/sandbox-orders-api')).data.value;
  expect((await gateway(resource)).status).toBe(404);
  try {
    expect(
      (
        await gateway(resource, 'PUT', {
          name: id,
          uri,
          host,
          priority: 100,
          upstream_id: source.upstream_id,
        })
      ).status,
    ).toBeLessThan(300);
    const [name, value] = cookie.split('=');
    await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
    await page.goto('/routes/' + id + '/edit?cluster=' + cluster.id);
    await page.getByRole('tab', { name: '插件配置' }).click();
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    const search = page.getByPlaceholder('搜索插件名称或用途');
    await search.fill('inspect');
    await expect(
      page
        .locator('.plugin-picker button')
        .filter({ has: page.getByText('inspect', { exact: true }) }),
    ).toHaveCount(0);
    await search.fill('limit-count');
    await page
      .locator('.plugin-picker button')
      .filter({ has: page.getByText('limit-count', { exact: true }) })
      .click();
    const dialog = page.locator('.plugin-config-dialog');
    await dialog.getByLabel('count', { exact: true }).fill('1');
    await dialog.getByLabel('time_window', { exact: true }).fill('60');
    await dialog.getByLabel('rejected_code', { exact: true }).fill('429');
    await dialog.getByRole('button', { name: '应用到路由' }).click();
    await expect(dialog).toBeHidden();
    const published = page.waitForResponse(
      (res) => res.url().endsWith('/config/apply') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存并发布', exact: true }).first().click();
    const response = await published;
    expect(response.ok()).toBe(true);
    expect((await waitChange((await response.json()).id)).status).toBe('succeeded');
    expect((await gateway(resource)).data.value.plugins['limit-count']).toMatchObject({
      count: 1,
      time_window: 60,
      rejected_code: 429,
    });
    const headers = { host };
    await expect
      .poll(async () => {
        const r = await sandboxProxy(uri, { headers });
        return r.status === 200 && (await r.json()).service === 'dashboard-sandbox';
      })
      .toBe(true);
    await expect.poll(async () => (await sandboxProxy(uri, { headers })).status).toBe(429);
  } finally {
    await gateway(resource, 'DELETE');
    expect((await gateway(resource)).status).toBe(404);
  }
});

import { test, expect, type Page } from '@playwright/test';
import { sandboxClient, sandboxProxy } from '../../scripts/sandbox-client.mjs';
import { consumerAuthFixtures } from '../../scripts/consumer-auth-fixtures.mjs';

let client: any, cluster: any, fixture: any;
const runId = `auth-ui-${Date.now()}`;
const names = [
  'key-auth',
  'basic-auth',
  'jwt-auth',
  'hmac-auth',
  'jwe-decrypt',
  'ldap-auth',
  'ldap-auth-advanced',
  'wolf-rbac',
];

test.beforeAll(async () => {
  client = await sandboxClient();
  cluster = (await client.request('/clusters')).find(
    (c: any) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  );
  expect(cluster && !cluster.read_only).toBeTruthy();
  fixture = await consumerAuthFixtures(runId);
});
test.afterAll(async () => {
  if (fixture) await fixture.cleanup();
});

async function open(page: Page, path: string) {
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}cluster=${cluster.id}`);
}
async function fields(page: Page, values: any) {
  const dialog = page.locator('.plugin-config-dialog');
  for (const [name, value] of Object.entries(values)) {
    // HMAC's signed_headers defaults to [date]; leave that default intact.
    if (Array.isArray(value)) continue;
    const input = dialog.getByLabel(name, { exact: true });
    if ((await input.getAttribute('role')) === 'combobox') {
      await expect(input).toHaveAttribute('aria-expanded', 'false');
      await input.press('ArrowDown');
      await expect(input).toHaveAttribute('aria-expanded', 'true');
      const option =
        typeof value === 'boolean' ? (value ? '启用 true' : '停用 false') : String(value);
      const listID = await input.getAttribute('aria-controls');
      const popup = page
        .locator('.ant-select-dropdown')
        .filter({ has: page.locator(`[id="${listID}"]`) });
      await popup
        .locator('.ant-select-item-option-content')
        .getByText(option, { exact: true })
        .click();
      await expect(input).toHaveAttribute('aria-expanded', 'false');
    } else await input.fill(String(value));
  }
}
async function release(page: Page) {
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: '草稿差异预览' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '创建发布变更', exact: true }).click();
  await page.getByLabel('变更说明').fill('逐插件表单、发布与真实流量验收');
  await page.getByRole('button', { name: '创建并查看差异' }).click();
  await page.getByRole('button', { name: '执行发布前校验' }).click();
  await expect(page.getByRole('button', { name: '发布到网关', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发布到网关', exact: true }).click();
  await page.getByRole('checkbox', { name: '我已核对目标集群与配置差异' }).check();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(
    page.getByText('配置已写入，并通过 Admin API 回读确认', { exact: true }),
  ).toBeVisible();
}
for (const name of names)
  test(`${name}：消费者表单、路由提示、路由表单发布和真实认证`, async ({ page }) => {
    test.setTimeout(120_000);
    const id = `${runId}-${name}`;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await open(page, `/consumers/new?plugin=${name}`);
      await expect(page.getByRole('dialog')).toBeVisible();
      await fields(page, fixture.credentials[name]);
      if (name === 'jwt-auth') {
        await fields(page, { algorithm: 'RS256' });
        await expect(
          page.getByRole('dialog').getByLabel('public_key', { exact: true }),
        ).toBeVisible();
        await fields(page, { algorithm: 'HS256' });
      }
      await page.getByRole('button', { name: '应用到消费者' }).click();
      await expect(page.locator('.plugin-config-dialog:visible')).toHaveCount(0);
      await page.getByLabel('消费者用户名', { exact: true }).fill(id);
      await release(page);
      expect(
        (
          await client.gateway(`/routes/${id}`, 'PUT', {
            uri: `/${id}`,
            upstream: fixture.upstream,
          })
        ).status,
      ).toBeLessThan(300);
      await open(page, `/routes/${id}/edit`);
      await page.getByRole('tab', { name: '插件配置' }).click();
      await page.getByRole('button', { name: '添加插件', exact: true }).click();
      await page.getByPlaceholder('搜索插件名称或用途').fill(name);
      await page
        .locator('.plugin-picker button')
        .filter({ has: page.locator('code').getByText(name, { exact: true }) })
        .click();
      await expect(page.getByRole('dialog').getByText('此插件与消费者配置关联')).toBeVisible();
      await expect(
        page.getByRole('dialog').getByRole('link', { name: '创建认证凭据' }),
      ).toHaveAttribute('href', `/consumers/new?cluster=${cluster.id}&plugin=${name}`);
      await fields(page, fixture.routes[name]);
      await page.getByRole('button', { name: '应用到路由' }).click();
      await expect(page.locator('.plugin-config-dialog:visible')).toHaveCount(0);
      await release(page);
      for (const [headers, expected] of [
        [{}, name === 'jwe-decrypt' ? 403 : 401],
        [
          fixture.headers(name, fixture.credentials[name], true),
          name === 'jwe-decrypt' ? 400 : name === 'wolf-rbac' ? 403 : 401,
        ],
        [fixture.headers(name), 200],
      ] as const) {
        await expect
          .poll(async () => {
            const response = await sandboxProxy(`/${id}`, { headers });
            await response.text();
            return response.status;
          })
          .toBe(expected);
      }
      await open(page, `/consumers/${id}/edit`);
      await page.getByRole('button', { name: `编辑插件 ${name}`, exact: true }).click();
      const schema = await client.request(
        `/clusters/${cluster.id}/plugins/${name}/schema?scope=consumer`,
      );
      for (const field of schema.encrypt_fields || []) {
        const input = page.getByRole('dialog').getByLabel(field, { exact: true });
        await expect(input).toHaveValue('');
        await expect(input).toHaveAttribute('type', 'password');
      }
      if (['basic-auth', 'jwt-auth', 'jwe-decrypt'].includes(name))
        await page.getByRole('dialog').screenshot({
          path: `.local/screenshots/consumer-${name}-schema.png`,
          animations: 'disabled',
        });
      if (name === 'basic-auth') {
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: '.local/screenshots/consumer-basic-mobile.png',
          fullPage: false,
          animations: 'disabled',
        });
      }
      if (['basic-auth', 'jwt-auth'].includes(name)) {
        const field = name === 'basic-auth' ? 'password' : 'key';
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel(field, { exact: true }).fill('temporary-value-to-discard');
        await dialog.getByText('JSON', { exact: true }).click();
        await dialog.getByText('配置表单', { exact: true }).click();
        await dialog.getByLabel(field, { exact: true }).fill('');
        await page.getByRole('button', { name: '应用到消费者' }).click();
        await expect(page.getByRole('dialog')).not.toBeVisible();
      }
      expect(errors).toEqual([]);
    } finally {
      await client.gateway(`/routes/${id}`, 'DELETE');
      await client.gateway(`/consumers/${id}`, 'DELETE');
      for (const draft of await client.request(`/drafts?cluster_id=${cluster.id}`))
        if (draft.resource_id === id && draft.status === 'draft')
          await client.request(`/drafts/${draft.id}`, 'DELETE');
    }
  });

import { test, expect, type Page } from '@playwright/test';
import { sandboxClient, sandboxProxy } from '../../scripts/sandbox-client.mjs';

async function setup(page: Page, path: string) {
  const client = await sandboxClient();
  const cluster = (await client.request('/clusters')).find(
    (c: any) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  );
  expect(cluster).toBeTruthy();
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto(`${path}?cluster=${cluster.id}`);
  return { client, cluster };
}
async function save(page: Page, title: string) {
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: '草稿差异预览' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '创建发布变更', exact: true }).click();
  await page.getByLabel('变更说明').fill(title);
  await page.getByRole('button', { name: '创建并查看差异' }).click();
}
async function publish(page: Page) {
  await page.getByRole('button', { name: '执行发布前校验' }).click();
  await expect(page.getByRole('button', { name: '发布到网关', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发布到网关', exact: true }).click();
  await page.getByRole('checkbox', { name: '我已核对目标集群与配置差异' }).check();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(
    page.getByText('配置已写入，并通过 Admin API 回读确认', { exact: true }),
  ).toBeVisible();
}
async function traffic(path: string, key: string | undefined, expected: number) {
  await expect
    .poll(async () => {
      const response = await sandboxProxy(path, key ? { headers: { apikey: key } } : {});
      await response.text();
      return response.status;
    })
    .toBe(expected);
}

test('路由 API Key 编辑器明确指向消费者，独立标签页保留当前编辑', async ({ page }) => {
  const { cluster } = await setup(page, '/routes/sandbox-health/edit');
  await page.getByLabel('资源说明', { exact: true }).fill('未保存的认证说明');
  await page.getByRole('tab', { name: '插件配置' }).click();
  await page.getByRole('button', { name: '编辑插件 key-auth' }).click();
  const dialog = page.getByRole('dialog', { name: 'API Key 认证 key-auth' });
  await expect(dialog.getByText('此插件与消费者配置关联')).toBeVisible();
  const link = dialog.getByRole('link', { name: '管理关联消费者' });
  await expect(link).toHaveAttribute('href', `/consumers?cluster=${cluster.id}&plugin=key-auth`);
  const opened = page.context().waitForEvent('page');
  await link.click();
  const consumerPage = await opened;
  await expect(consumerPage.getByRole('heading', { name: '消费者管理' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/key-auth-guidance.png', fullPage: true });
  await consumerPage.close();
});

test('消费者界面创建密钥、脱敏、发布、保留、轮换和回退', async ({ page }) => {
  test.setTimeout(150_000);
  const id = `consumer-ui-${Date.now()}`;
  const { client, cluster } = await setup(page, '/consumers/new');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    expect(
      (
        await client.gateway(`/routes/${id}`, 'PUT', {
          uri: `/${id}`,
          plugins: { 'key-auth': {} },
          upstream: { nodes: { 'echo:80': 1 }, type: 'roundrobin' },
        })
      ).status,
    ).toBeLessThan(300);
    await page.getByLabel('消费者用户名', { exact: true }).fill(id);
    await page.getByRole('button', { name: '选择插件', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /API Key 认证/ })
      .click();
    await page.getByRole('button', { name: '应用到消费者草稿' }).click();
    await expect(page.getByText('配置需要调整')).toBeVisible();
    await page.getByRole('button', { name: '生成 key', exact: true }).click();
    const input = page.getByLabel('key', { exact: true });
    const key = await input.inputValue();
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await expect(input).toHaveAttribute('type', 'password');
    await expect(page.locator('.editor-aside .config-preview')).not.toContainText(key);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: '复制 key', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
    await page.getByRole('button', { name: '应用到消费者草稿' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByLabel('资源说明', { exact: true }).fill('平台健康检查调用方');
    await page.screenshot({ path: '.local/screenshots/consumer-key-editor.png', fullPage: true });
    await save(page, `${id} 创建`);
    expect((await client.gateway(`/consumers/${id}`)).status).toBe(404);
    await expect(page.locator('body')).not.toContainText(key);
    await publish(page);
    await traffic(`/${id}`, undefined, 401);
    await traffic(`/${id}`, key, 200);
    await page.getByRole('button', { name: '消费者管理', exact: true }).click();
    await page.getByRole('button', { name: id, exact: true }).click();
    await expect(page.getByLabel('消费者用户名', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '编辑插件 key-auth' }).click();
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', '已配置，留空保持原值');
    await expect(page.getByRole('button', { name: '复制 key', exact: true })).toBeDisabled();
    await input.fill('temporary-replacement');
    await input.fill('');
    await page.getByRole('button', { name: '应用到消费者草稿' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByLabel('资源说明', { exact: true }).fill('更新说明，保留已有密钥');
    await save(page, `${id} 保留`);
    await publish(page);
    await traffic(`/${id}`, key, 200);
    await page.getByRole('button', { name: '消费者管理', exact: true }).click();
    await page.getByRole('button', { name: id, exact: true }).click();
    await page.getByRole('button', { name: '编辑插件 key-auth' }).click();
    await page.getByRole('button', { name: '生成 key', exact: true }).click();
    const replacement = await input.inputValue();
    expect(replacement).not.toBe(key);
    await page.getByRole('button', { name: '应用到消费者草稿' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await save(page, `${id} 轮换`);
    await traffic(`/${id}`, key, 200);
    await traffic(`/${id}`, replacement, 401);
    await publish(page);
    await traffic(`/${id}`, replacement, 200);
    await traffic(`/${id}`, key, 401);
    await page.getByRole('button', { name: '生成回退变更' }).click();
    await expect(
      page.getByText('这是一个新的回退变更，尚需校验和发布。', { exact: true }),
    ).toBeVisible();
    await publish(page);
    await traffic(`/${id}`, key, 200);
    await traffic(`/${id}`, replacement, 401);
    expect(errors).toEqual([]);
  } finally {
    await client.gateway(`/routes/${id}`, 'DELETE');
    await client.gateway(`/consumers/${id}`, 'DELETE');
    for (const draft of await client.request(`/drafts?cluster_id=${cluster.id}`))
      if (draft.resource_id === id && draft.status === 'draft')
        await client.request(`/drafts/${draft.id}`, 'DELETE');
  }
});

test('消费者管理深浅主题、窄屏布局和只读控制', async ({ page }) => {
  const { client, cluster } = await setup(page, '/consumers');
  await expect(page.getByRole('heading', { name: '消费者管理' })).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/consumers-light.png', fullPage: true });
  await page.getByRole('button', { name: '切换颜色主题' }).click();
  await page.screenshot({ path: '.local/screenshots/consumers-dark.png', fullPage: true });
  await page.getByRole('button', { name: '新建消费者', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/screenshots/consumer-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const clusters = await client.request('/clusters');
  await page.route('**/api/v1/clusters', (route) =>
    route.fulfill({
      json: clusters.map((c: any) => (c.id === cluster.id ? { ...c, read_only: true } : c)),
    }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true }).first()).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加插件', exact: true })).toBeDisabled();
});

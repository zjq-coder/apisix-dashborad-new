import { test, expect, type Page } from '@playwright/test';
import { localConfig, sandboxClient } from '../../scripts/sandbox-client.mjs';

async function login(page: Page) {
  const config = await localConfig();
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill(config.DASHBOARD_PASSWORD);
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

test('真实配置列表、深浅主题和窄屏布局', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: '路由管理', exact: true }).click();
  await expect(page.getByRole('button', { name: 'order-api', exact: true })).toBeVisible();
  await page.screenshot({
    path: '.local/screenshots/routes-light.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换颜色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: '.local/screenshots/routes-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  await expect
    .poll(() =>
      page
        .locator('.ant-table-thead th')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe('rgb(28, 41, 64)');
  await page.getByRole('button', { name: '切换颜色主题' }).click();
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.screenshot({
    path: '.local/screenshots/routes-tablet.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

async function saveAndCreateChange(page: Page, reason: string) {
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: '草稿差异预览' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('columnheader', { name: '目标值 / 发布后' })).toBeVisible();
  await drawer.getByRole('button', { name: '创建发布变更', exact: true }).click();
  await page.getByLabel('变更说明').fill(reason);
  await page.getByRole('button', { name: '创建并查看差异' }).click();
  await expect(page.getByRole('button', { name: '执行发布前校验' })).toBeVisible();
}

async function publish(page: Page) {
  await page.getByRole('button', { name: '执行发布前校验' }).click();
  const button = page.getByRole('button', { name: '发布到网关', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await page.getByRole('checkbox', { name: '我已核对目标集群与配置差异' }).check();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(
    page.getByText('配置已写入，并通过 Admin API 回读确认', { exact: true }),
  ).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

test('上游、路由、插件、草稿差异、发布与回退完整闭环', async ({ page }) => {
  const id = `e2e-${Date.now()}`;
  const upstream = `${id}-upstream`;
  const route = `${id}-route`;
  const client = await sandboxClient();
  try {
    await login(page);
    await page.getByRole('button', { name: '上游管理', exact: true }).click();
    await page.getByRole('button', { name: '新建上游', exact: true }).click();
    await page.getByLabel('资源名称', { exact: true }).fill('浏览器验收上游');
    await page.getByLabel('资源 ID', { exact: true }).fill(upstream);
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
    await page.getByLabel('节点地址 1', { exact: true }).fill('echo:80');
    await saveAndCreateChange(page, '浏览器自动化验收：创建上游');
    expect((await client.gateway(`/upstreams/${upstream}`)).status).toBe(404);
    const upstreamChange = await publish(page);

    await page.getByRole('button', { name: '路由管理', exact: true }).click();
    await page.getByRole('button', { name: '新建路由', exact: true }).click();
    await page.getByLabel('资源名称', { exact: true }).fill('浏览器验收路由');
    await page.getByLabel('资源 ID', { exact: true }).fill(route);
    await page.getByLabel('匹配路径 URI', { exact: true }).fill(`/${id}/*`);
    await page.getByRole('tab', { name: '上游服务' }).click();
    await page.getByLabel('选择上游', { exact: true }).click();
    await page.getByTitle(`浏览器验收上游 · ${upstream}`, { exact: true }).click();
    await page.getByRole('tab', { name: '插件配置' }).click();
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    await page.getByPlaceholder('搜索插件名称或用途').fill('limit-req');
    await page.locator('.plugin-picker button').filter({ hasText: 'limit-req' }).click();
    await page.getByRole('spinbutton', { name: 'rate', exact: true }).fill('40');
    await page.getByRole('spinbutton', { name: 'burst', exact: true }).fill('10');
    await page.getByRole('button', { name: '应用到路由草稿', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: '编辑插件 limit-req' })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: '.local/screenshots/route-editor.png',
      fullPage: true,
      animations: 'disabled',
    });
    await saveAndCreateChange(page, '浏览器自动化验收：路由与限流插件');
    await page.screenshot({ path: '.local/screenshots/release-review.png', fullPage: true });
    expect((await client.gateway(`/routes/${route}`)).status).toBe(404);
    const routeChange = await publish(page);
    const live = await client.gateway(`/routes/${route}`);
    expect(live.data.value.plugins['limit-req'].rate).toBe(40);
    await expect
      .poll(async () => (await fetch(`http://127.0.0.1:19080/${id}/hello`)).status)
      .toBe(200);
    await page.getByRole('button', { name: '生成回退变更' }).click();
    await expect(
      page.getByText('这是一个新的回退变更，尚需校验和发布。', { exact: true }),
    ).toBeVisible();
    expect((await client.gateway(`/routes/${route}`)).status).toBe(200);
    await publish(page);
    expect((await client.gateway(`/routes/${route}`)).status).toBe(404);
    const rollback = await client.request(`/changesets/${upstreamChange}/rollback`, 'POST', {});
    await client.request(`/changesets/${rollback.id}/publish`, 'POST', {});
    expect((await client.waitChange(rollback.id)).status).toBe('succeeded');
    expect(routeChange).toBeTruthy();
  } finally {
    await client.gateway(`/routes/${route}`, 'DELETE');
    await client.gateway(`/upstreams/${upstream}`, 'DELETE');
    const clusters = await client.request('/clusters');
    const cluster = clusters.find(
      (c: { url: string }) => c.url === 'http://apisix:9180/apisix/admin',
    );
    if (cluster)
      for (const d of await client.request(`/drafts?cluster_id=${cluster.id}`)) {
        if ([route, upstream].includes(d.resource_id) && d.status === 'draft')
          await client.request(`/drafts/${d.id}`, 'DELETE');
      }
  }
});

test('未保存保护与 JSON 编辑器可用', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '路由管理', exact: true }).click();
  await page.getByRole('button', { name: '新建路由', exact: true }).click();
  await page.getByLabel('资源名称', { exact: true }).fill('尚未保存');
  await page.getByRole('button', { name: '草稿箱', exact: true }).click();
  await expect(page.getByText('保留当前编辑？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('资源名称', { exact: true })).toHaveValue('尚未保存');
  await page.getByText('JSON 编辑', { exact: true }).click();
  const editor = page.locator('.monaco-editor textarea').first();
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('{ invalid json');
  await expect(page.getByText('配置必须是有效的 JSON 对象', { exact: true })).toBeVisible();
  await page.getByText('可视化表单', { exact: true }).click();
  await expect(
    page.getByText('JSON 格式不正确，请修正后切换到表单', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '路由管理', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并离开' }).click();
  await expect(page.getByRole('button', { name: '新建路由', exact: true })).toBeVisible();
});

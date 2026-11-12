import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';

// This suite enters the local Admin API key in a real form; Playwright traces include fill values.
test.use({ trace: 'off' });

test('已有变更和草稿的连接可以移除，保留历史且禁止继续发布', async () => {
  const client = await sandboxClient();
  const marker = 'connection-history-' + Date.now();
  const cluster = await client.request('/clusters', 'POST', {
    name: marker,
    environment: 'staging',
    url: 'http://apisix:9180',
    api_key: client.config.APISIX_ADMIN_KEY,
  });
  const path = '/clusters/' + cluster.id;
  try {
    const draft = await client.request('/drafts', 'POST', {
      cluster_id: cluster.id,
      resource_type: 'upstreams',
      resource_id: marker,
      action: 'create',
      value: { type: 'roundrobin', nodes: { 'echo:80': 1 } },
    });
    const change = await client.request('/changesets', 'POST', {
      draft_ids: [draft.id],
      title: marker,
      reason: '验证解除接入后的历史记录',
    });
    await client.request(path, 'DELETE');
    expect((await client.request('/drafts/' + draft.id)).id).toBe(draft.id);
    expect((await client.request('/changesets/' + change.id)).operations[0].resource_id).toBe(
      marker,
    );
    await expect(
      client.request('/changesets/' + change.id + '/publish', 'POST'),
    ).rejects.toHaveProperty('status', 404);
    expect((await client.gateway('/upstreams/' + marker)).status).toBe(404);
  } finally {
    if ((await client.request('/clusters')).some((c: { id: string }) => c.id === cluster.id))
      await client.request(path, 'DELETE');
  }
});

async function open(page: Page, id?: string) {
  const client = await sandboxClient();
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto('/clusters' + (id ? '?cluster=' + id : ''));
}

test('集群连接可接入、编辑、筛选和删除，桌面与手机均可完成操作', async ({ page }) => {
  const client = await sandboxClient();
  const unique = '界面验收-' + Date.now();
  const renamed = unique + '-已编辑';
  let id = '';
  try {
    await open(page);
    await page.getByRole('button', { name: '接入集群', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('集群名称').fill(unique);
    await dialog.getByLabel('Admin API 地址').fill('ftp://apisix:9180');
    await dialog.getByRole('button', { name: '保存并检测' }).click();
    await expect(dialog.getByText('请输入完整的 HTTP 或 HTTPS 地址')).toBeVisible();
    await dialog.getByLabel('Admin API 地址').fill('http://apisix:9180');
    await dialog.getByLabel('Admin API Key').fill(client.config.APISIX_ADMIN_KEY);
    await dialog.getByRole('button', { name: '保存并检测' }).click();
    const selected = page.locator('.selected-cluster');
    await expect(selected.getByRole('heading', { name: unique, exact: true })).toBeVisible();
    id = new URL(page.url()).searchParams.get('cluster')!;
    expect(id).toBeTruthy();
    await expect(selected.locator('.connection-health')).toHaveText('健康');
    await expect(selected.getByText('可读取路由配置')).toBeVisible();
    await selected.getByRole('button', { name: '编辑' }).click();
    await expect(dialog.getByLabel('Admin API Key')).toBeEmpty();
    await dialog.getByLabel('集群名称').fill(renamed);
    await dialog.getByLabel('Admin API Key').fill('invalid-ui-test-key');
    await dialog.getByRole('button', { name: '保存并检测' }).click();
    await expect(selected.getByRole('heading', { name: renamed })).toBeVisible();
    await expect(selected.locator('.connection-health')).toHaveText('异常');
    await expect(selected.locator('.connection-fault')).toContainText('HTTP 401');
    await selected.getByRole('button', { name: '编辑' }).click();
    await dialog.getByLabel('Admin API Key').fill(client.config.APISIX_ADMIN_KEY);
    await dialog.getByRole('button', { name: '保存并检测' }).click();
    await expect(selected.locator('.connection-health')).toHaveText('健康');
    const search = page.getByRole('textbox', { name: '搜索集群' });
    await search.fill(renamed);
    await expect(page.locator('.cluster-card')).toHaveCount(1);
    await page.getByRole('button', { name: /^异常/ }).click();
    await expect(page.getByText('没有匹配的集群连接')).toBeVisible();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(search).toBeEmpty();
    await expect(page.locator('.ant-message-notice')).toHaveCount(0);
    await mkdir('.local/screenshots', { recursive: true });
    await page.screenshot({
      path: '.local/screenshots/cluster-connections-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await search.fill(renamed);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: '.local/screenshots/cluster-connections-mobile.png',
      fullPage: true,
    });
    await selected.getByRole('button', { name: '删除连接' }).click();
    await expect(dialog.getByText('确认从 Dashboard 移除「' + renamed + '」？')).toBeVisible();
    await dialog.getByRole('button', { name: /^取\s*消$/ }).click();
    await expect(selected.getByRole('heading', { name: renamed })).toBeVisible();
    await selected.getByRole('button', { name: '删除连接' }).click();
    await dialog.getByRole('button', { name: '删除连接' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('集群连接已删除')).toBeVisible();
    await search.fill('');
    await expect(page.getByRole('heading', { name: renamed })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('cluster')).not.toBe(id);
    await page.reload();
    await expect(page.locator('.selected-cluster')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('console.cluster'))).not.toBe(id);
  } finally {
    const leftovers = (await client.request('/clusters')).filter(
      (c: { name: string }) => c.name === unique || c.name === renamed,
    );
    for (const c of leftovers) await client.request('/clusters/' + c.id, 'DELETE');
  }
});

test('删除最后一个可见连接后清除选择，过期检测不会显示健康', async ({ page }) => {
  const client = await sandboxClient();
  const row = await client.request('/clusters', 'POST', {
    name: '末条连接-' + Date.now(),
    environment: 'staging',
    url: 'http://apisix:9180',
    api_key: client.config.APISIX_ADMIN_KEY,
  });
  try {
    // Isolate the list presented to this browser; deletes still reach the real backend.
    await page.route('**/api/v1/clusters', async (route) => {
      const response = await route.fetch();
      const rows = (await response.json()).filter((c: { id: string }) => c.id === row.id);
      for (const c of rows) {
        c.status = 'connected';
        c.last_checked = new Date(Date.now() - 180000).toISOString();
      }
      await route.fulfill({ response, json: rows });
    });
    await open(page, row.id);
    await expect(page.locator('.connection-health')).toHaveText('检测已过期');
    await page.getByRole('button', { name: /^待确认/ }).click();
    await expect(page.locator('.cluster-card')).toHaveCount(1);
    await page.getByRole('button', { name: '删除连接' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除连接' }).click();
    await expect(page.getByRole('button', { name: '接入第一个集群' })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('cluster')).toBe(false);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('console.cluster')))
      .toBeNull();
  } finally {
    if ((await client.request('/clusters')).some((c: { id: string }) => c.id === row.id))
      await client.request('/clusters/' + row.id, 'DELETE');
  }
});

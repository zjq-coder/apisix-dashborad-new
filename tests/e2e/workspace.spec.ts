import { expect, test, type Page } from '@playwright/test';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';
import type { Cluster, Draft } from '../../web/src/types';

let client: Awaited<ReturnType<typeof sandboxClient>>;
let dev: Cluster;
let staging: Cluster | undefined;
test.beforeAll(async () => {
  client = await sandboxClient();
  const clusters: Cluster[] = await client.request('/clusters');
  dev = clusters.find((c) => c.url === 'http://apisix:9180/apisix/admin')!;
  staging = clusters.find((c) => c.url === 'http://apisix-staging:9180/apisix/admin');
  expect(dev).toBeTruthy();
});

async function open(page: Page, cluster = dev) {
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto('/?cluster=' + cluster.id);
  await expect(page.getByRole('heading', { name: '配置工作台', exact: true })).toBeVisible();
}

test('打开、停留与切换环境只读取管理摘要，旧采集接口已下线', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (req) => {
    if (['fetch', 'xhr'].includes(req.resourceType()))
      requests.push(req.method() + ' ' + new URL(req.url()).pathname);
  });
  await open(page);
  const scope = (c: Cluster) => '/api/v1/clusters/' + c.id + '/workspace';
  await page.waitForLoadState('networkidle');
  expect([...new Set(requests)].sort()).toEqual(
    ['GET /api/v1/session', 'GET /api/v1/clusters', 'GET ' + scope(dev)].sort(),
  );
  const loaded = requests.length;
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await page.waitForLoadState('networkidle');
  expect(requests).toHaveLength(loaded);
  if (staging) {
    const next = page.waitForResponse(
      (r) => new URL(r.url()).pathname === scope(staging!) && r.ok(),
    );
    await page.getByRole('combobox', { name: '当前集群' }).click();
    await page
      .locator('.ant-select-dropdown:visible')
      .getByText(staging.name, { exact: true })
      .click();
    await next;
    await expect(page.locator('.config-workspace .page-heading')).toContainText(staging.name);
    expect(requests.slice(loaded)).toEqual(['GET ' + scope(staging)]);
  }
  for (const method of ['GET', 'POST']) {
    await expect(
      client.request('/clusters/' + dev.id + '/traffic?window=300', method),
    ).rejects.toMatchObject({ status: 404 });
  }
  const anonymous = await fetch('http://127.0.0.1:18080' + scope(dev));
  expect(anonymous.status).toBe(401);
  await expect(client.request('/clusters/missing-workspace-test/workspace')).rejects.toMatchObject({
    status: 404,
  });
});

test('待审草稿只返回当前环境最新四条元数据，条目直接打开差异和变更详情', async ({ page }) => {
  const prefix = 'workspace-' + crypto.randomUUID().slice(0, 8);
  const drafts: Draft[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const id = prefix + '-' + i;
      drafts.push(
        await client.request('/drafts', 'POST', {
          cluster_id: dev.id,
          resource_type: 'routes',
          resource_id: id,
          action: 'create',
          title: id,
          value: { uri: '/' + id, upstream_id: 'sandbox-orders' },
        }),
      );
    }
    const summary = await client.request('/clusters/' + dev.id + '/workspace');
    expect(summary.drafts.map((d: Draft) => d.id)).toEqual(
      drafts
        .slice(1)
        .reverse()
        .map((d) => d.id),
    );
    for (const d of summary.drafts)
      expect(Object.keys(d).sort()).toEqual(
        ['id', 'title', 'action', 'resource_id', 'resource_type', 'updated_at'].sort(),
      );
    expect(summary.changes.length).toBeLessThanOrEqual(4);
    expect(summary.changes.length).toBeGreaterThan(0);
    for (const c of summary.changes)
      expect(Object.keys(c).sort()).toEqual(
        ['id', 'title', 'status', 'rollback_of', 'created_by', 'created_at'].sort(),
      );
    if (staging) {
      const other = await client.request('/clusters/' + staging.id + '/workspace');
      expect(other.drafts.some((d: Draft) => d.title.startsWith(prefix))).toBe(false);
    }
    await open(page);
    const latest = drafts[4];
    await expect(page.getByRole('link').filter({ hasText: drafts[0].title })).toHaveCount(0);
    // Reproduce an older pending draft outside the general draft list's history window.
    await page.route('**/api/v1/drafts?cluster_id=*', (route) => route.fulfill({ json: [] }));
    await page.getByRole('link').filter({ hasText: latest.title }).click();
    const drawer = page.getByRole('dialog', { name: '草稿差异预览' });
    await expect(drawer.getByRole('heading', { name: latest.title })).toBeVisible();
    await expect(drawer.getByRole('columnheader', { name: '目标值 / 发布后' })).toBeVisible();
    expect((await client.gateway('/routes/' + latest.resource_id)).status).toBe(404);
    await open(page);
    const change = summary.changes[0];
    await page.locator('a[href^="/changes/' + change.id + '?"]').click();
    await expect(page).toHaveURL(new RegExp('/changes/' + change.id + '\\?cluster=' + dev.id));
    await expect(page.locator('h1')).toBeVisible();
  } finally {
    for (const draft of drafts) await client.request('/drafts/' + draft.id, 'DELETE');
  }
});

test('配置入口保留所选环境，工作台适配浅色、深色与窄屏', async ({ page }) => {
  const cluster = staging || dev;
  await open(page, cluster);
  for (const [path, title] of [
    ['routes', '路由管理'],
    ['upstreams', '上游管理'],
    ['consumers', '消费者管理'],
    ['plugins', '插件目录'],
  ]) {
    const link = page
      .getByRole('navigation', { name: '配置入口' })
      .getByRole('link', { name: new RegExp(title) });
    await expect(link).toHaveAttribute('href', '/' + path + '?cluster=' + cluster.id);
    await link.click();
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回配置工作台' }).click();
  }
  await expect(page.locator('.workspace-skeleton')).toHaveCount(0);
  await page.screenshot({
    path: '.local/screenshots/workspace-light.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换颜色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: '.local/screenshots/workspace-dark.png',
    fullPage: true,
    animations: 'disabled',
  });
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name: '新建路由' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({
    path: '.local/screenshots/workspace-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('从工作台首次读取路由时只显示一个新建入口，数据到达后再显示列表', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/clusters/*/resources/routes', async (route) => {
    await pending;
    await route.continue();
  });
  await open(page);
  try {
    const started = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith('/resources/routes'),
    );
    await page
      .getByRole('navigation', { name: '配置入口' })
      .getByRole('link', { name: /路由管理/ })
      .click();
    await started;
    await expect(page.getByRole('button', { name: '新建路由', exact: true })).toHaveCount(1);
    await expect(page.getByText('当前环境暂无路由配置')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: 'health-check', exact: true })).toBeVisible();
});

test('只读集群可以浏览配置，摘要失败可重试，空环境有清晰的草稿和发布空态', async ({ page }) => {
  await page.route('**/api/v1/clusters', (route) =>
    route.fulfill({ json: [{ ...dev, read_only: true }] }),
  );
  let available = false;
  await page.route('**/workspace', (route) =>
    route.fulfill(
      available
        ? { json: { drafts: [], changes: [] } }
        : { status: 503, json: { error: '数据库不可用' } },
    ),
  );
  await open(page);
  await expect(page.getByRole('button', { name: '新建路由' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '待审草稿' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '配置入口' }).getByRole('link')).toHaveCount(4);
  const retry = page.getByRole('button', { name: '重试' });
  await expect(retry).toBeVisible();
  available = true;
  await retry.click();
  await expect(page.getByText('暂无待审草稿', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无发布记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换语言' }).click();
  await page.getByRole('menuitem', { name: 'English', exact: true }).click();
  await expect(page.getByText('No drafts to review', { exact: true })).toBeVisible();
  await expect(page.getByText('No releases yet', { exact: true })).toBeVisible();
});

import { test, expect, type Page } from '@playwright/test';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';
import hub from '../../web/src/data/plugin-hub.json' with { type: 'json' };

let client: Awaited<ReturnType<typeof sandboxClient>>;
let clusterId: string;
let enabled: string[];

test.beforeAll(async () => {
  client = await sandboxClient();
  const clusters = await client.request('/clusters');
  clusterId = clusters.find((c: { url: string }) => c.url === 'http://apisix:9180/apisix/admin').id;
  enabled = await client.request(`/clusters/${clusterId}/plugins`);
});

async function open(page: Page, path = '/plugins') {
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto(`${path}?cluster=${clusterId}`);
}

const cards = (page: Page) => page.locator('.catalog-card');
const search = (page: Page) => page.getByRole('textbox', { name: '搜索插件' });
const pickCategory = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: '插件分类' })
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();

async function imagesOnPage(page: Page) {
  return cards(page)
    .locator('img')
    .evaluateAll(async (images) =>
      Promise.all(
        images.map(async (element) => {
          const image = element as HTMLImageElement;
          await image.decode();
          if (!image.naturalWidth || !image.naturalHeight)
            throw new Error(`Empty image: ${image.src}`);
          return image.getAttribute('src');
        }),
      ),
    );
}

test('集群启用完整插件清单时按官网顺序、分类和图标展示', async ({ page }) => {
  const externalImages: string[] = [];
  page.on('request', (r) => {
    if (
      r.resourceType() === 'image' &&
      /^https?:/.test(r.url()) &&
      new URL(r.url()).origin !== new URL(page.url()).origin
    )
      externalImages.push(r.url());
  });
  await page.route('**/api/v1/clusters/*/plugins', (route) =>
    route.fulfill({ json: hub.flatMap((group) => Object.keys(group.plugins)) }),
  );
  await open(page);
  await expect(page.getByRole('radio', { name: '官网目录' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '访问官网' })).toHaveAttribute(
    'href',
    'https://apisix.apache.org/zh/plugins/',
  );
  await expect(page.locator('.catalog-result-count')).toContainText('105 个插件');
  const nav = page.getByRole('navigation', { name: '插件分类' });
  await expect(nav.locator('button > span:not(.anticon)')).toHaveText([
    '全部分类',
    ...hub.map((g) => g.name),
  ]);
  let seen = 0;
  for (const group of hub) {
    await pickCategory(page, group.name);
    const entries = Object.entries(group.plugins);
    for (let start = 0; start < entries.length; start += 12) {
      const slice = entries.slice(start, start + 12);
      await expect(
        page.getByRole('region', { name: group.name }).locator('.catalog-card strong'),
      ).toHaveText(slice.map(([name]) => name));
      expect(await imagesOnPage(page)).toEqual(slice.map(([, icon]) => `/plugin-icons/${icon}`));
      seen += slice.length;
      if (start + 12 < entries.length) await page.locator('.ant-pagination-next button').click();
    }
  }
  expect(seen).toBe(105);
  expect(externalImages).toEqual([]);
});

test('真实集群的启用列表、每项配置结构、目录扩展和两种 Serverless 实例', async ({ page }) => {
  await open(page);
  await expect(page.locator('.catalog-result-count')).toContainText(
    `当前集群 · ${enabled.length} 个插件`,
  );
  const seen: string[] = [];
  for (let offset = 0; offset < enabled.length; offset += 12) {
    await expect(cards(page)).toHaveCount(Math.min(12, enabled.length - offset));
    const pageNames = await cards(page).locator('strong').allTextContents();
    expect(pageNames.every((name) => !seen.includes(name))).toBe(true);
    seen.push(...pageNames);
    await imagesOnPage(page);
    if (seen.length < enabled.length) {
      await page.locator('.ant-pagination-next button').click();
      await expect(cards(page).first().locator('strong')).not.toHaveText(pageNames[0]);
    }
  }
  expect(seen.sort()).toEqual([...enabled].sort());
  for (const name of enabled) {
    const schema = await client.request(
      `/clusters/${clusterId}/plugins/${encodeURIComponent(name)}/schema?scope=route`,
    );
    expect(Object.keys(schema).length, name).toBeGreaterThan(0);
  }
  await pickCategory(page, '集群扩展');
  await search(page).fill('ldap-auth-advanced');
  await page.getByRole('button', { name: '查看插件 ldap-auth-advanced', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: '插件 Schema' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: '官方插件文档' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await pickCategory(page, 'Serverless');
  for (const name of ['serverless-pre-function', 'serverless-post-function']) {
    await search(page).fill(name);
    const readSchema = page.waitForResponse(
      (r) => r.url().includes(`/plugins/${name}/schema`) && r.ok(),
    );
    await page.getByRole('button', { name: `查看插件 ${name}`, exact: true }).click();
    await readSchema;
    await expect(dialog.getByRole('link', { name: '官方插件文档' })).toHaveAttribute(
      'href',
      'https://apisix.apache.org/zh/docs/apisix/plugins/serverless/',
    );
    await expect(dialog.getByRole('textbox', { name: '插件 Schema' })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('用途和分类搜索、清空筛选与分页仅作用于已启用插件', async ({ page }) => {
  await page.route('**/api/v1/clusters/*/plugins', (route) =>
    route.fulfill({
      json: ['request-id', ...Array.from({ length: 12 }, (_, i) => `custom-example-${i}`)],
    }),
  );
  const schemaRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/schema')) schemaRequests.push(r.url());
  });
  await open(page);
  await expect(page.locator('.catalog-result-count')).toContainText('13 个插件');
  await page.locator('.ant-pagination-next button').click();
  await search(page).fill('  流量管理  唯一标识 ');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('request-id');
  await search(page).fill('limit-req');
  await expect(page.getByText('没有找到匹配的插件')).toBeVisible();
  await page.getByRole('button', { name: '重置筛选' }).click();
  await expect(cards(page).first()).toContainText('request-id');
  await expect(cards(page)).toHaveCount(12);
  expect(schemaRequests).toEqual([]);
});

test('集群读取失败可重试，刷新后反映空的启用清单', async ({ page }) => {
  let failed = true;
  let names = ['basic-auth'];
  await page.route('**/api/v1/clusters/*/plugins', (route) =>
    failed
      ? route.fulfill({ status: 502, json: { error: '测试集群未响应' } })
      : route.fulfill({ json: names }),
  );
  await open(page);
  await expect(page.getByText('测试集群未响应')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await expect(cards(page).locator('strong')).toHaveText(['basic-auth']);
  names = [];
  await page.getByRole('button', { name: '刷新插件' }).click();
  await expect(page.getByText('当前集群未启用插件')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('没有接入集群时可从目录进入集群接入页面', async ({ page }) => {
  await page.route('**/api/v1/clusters', (route) => route.fulfill({ json: [] }));
  await open(page);
  await expect(page.getByText('从接入第一个集群开始')).toBeVisible();
  await expect(page.getByRole('link', { name: '访问官网' })).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await page.getByRole('button', { name: '接入集群', exact: true }).click();
  await expect(page).toHaveURL(/\/clusters(?:\?|$)/);
});

test('桌面浅色、深色、平板和手机端图标与筛选布局', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(cards(page).first()).toBeVisible();
  await imagesOnPage(page);
  await page.screenshot({
    path: '.local/screenshots/plugin-hub-light.png',
    animations: 'disabled',
  });
  await pickCategory(page, '可观测性');
  await page.getByRole('button', { name: '切换颜色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await imagesOnPage(page);
  await page.screenshot({ path: '.local/screenshots/plugin-hub-dark.png', animations: 'disabled' });
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      String(width),
    ).toBe(true);
    if (width <= 1000)
      await expect(page.getByRole('combobox', { name: '筛选插件分类' })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: '筛选插件分类' }).click();
  const aiCount = Object.keys(hub.find((group) => group.name === 'AI')!.plugins).filter((name) =>
    enabled.includes(name),
  ).length;
  await page
    .locator('.ant-select-item-option-content')
    .getByText(`AI (${aiCount})`, { exact: true })
    .click();
  await expect(cards(page)).toHaveCount(aiCount);
  await page.getByRole('button', { name: '切换颜色主题' }).click();
  await imagesOnPage(page);
  await page.screenshot({
    path: '.local/screenshots/plugin-hub-mobile.png',
    animations: 'disabled',
  });
  await cards(page).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page.getByRole('dialog').evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

for (const scope of ['路由', '消费者'] as const) {
  test(`${scope}编辑器使用官网图标、分类和现有认证配置入口`, async ({ page }) => {
    await open(page, scope === '路由' ? '/routes/new' : '/consumers/new');
    if (scope === '路由') await page.getByRole('tab', { name: '插件配置' }).click();
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    await page.getByPlaceholder('搜索插件名称或用途').fill('basic-auth');
    const plugin = page
      .locator('.plugin-picker button')
      .filter({ has: page.getByText('basic-auth', { exact: true }) });
    await expect(plugin.locator('img')).toHaveAttribute(
      'src',
      '/plugin-icons/symbols/iconbasic-auth.svg',
    );
    await expect(plugin.getByText('认证', { exact: true })).toBeVisible();
    await plugin.click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(scope === '路由' ? '此插件与消费者配置关联' : '在此设置消费者凭据或策略'),
    ).toBeVisible();
    if (scope === '路由') {
      await dialog.getByRole('button', { name: '应用到路由草稿' }).click();
      await expect(page.locator('.attached-plugin img')).toHaveAttribute(
        'src',
        '/plugin-icons/symbols/iconbasic-auth.svg',
      );
    } else {
      await expect(dialog.getByLabel('username', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('password', { exact: true })).toBeVisible();
    }
  });
}

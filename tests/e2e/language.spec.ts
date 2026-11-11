import { test, expect, type Page, type Locator } from '@playwright/test';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';

let client: Awaited<ReturnType<typeof sandboxClient>>;
let clusterId: string;
test.beforeAll(async () => {
  client = await sandboxClient();
  const clusters = await client.request('/clusters');
  clusterId = clusters.find(
    (item: { url: string }) => item.url === 'http://apisix:9180/apisix/admin',
  ).id;
});

async function open(page: Page, path: string) {
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto(path + (path.includes('?') ? '&' : '?') + 'cluster=' + clusterId);
}

async function switchTo(page: Page, english: boolean, surface: Page | Locator = page) {
  await surface
    .getByRole('button', { name: english ? '切换语言' : 'Switch language', exact: true })
    .click();
  await page.getByRole('menuitem', { name: english ? 'English' : '简体中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', english ? 'en-US' : 'zh-CN');
}

test('登录页切换语言并即时翻译表单和服务端错误，刷新保留偏好', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByText('请输入密码', { exact: true })).toBeVisible();
  await switchTo(page, true);
  await expect(page.getByRole('heading', { name: 'Welcome to the console' })).toBeVisible();
  await expect(page.getByText('Enter your password', { exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('language-test-no-account');
  await page.getByLabel('Password', { exact: true }).fill('language-test-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Incorrect username or password' }),
  ).toBeVisible();
  await switchTo(page, false);
  await expect(page.getByText('用户名或密码不正确', { exact: true })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveValue('language-test-no-account');
  await switchTo(page, true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('APISIX Console · Gateway console');
});

test('九个主页面均支持中英文导航、主题、刷新及手机宽度', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await open(page, '/');
  await switchTo(page, true);
  const pages = [
    ['Configuration workspace', 'Configuration workspace', '配置工作台'],
    ['Routes', 'Routes', '路由管理'],
    ['Upstreams', 'Upstreams', '上游管理'],
    ['Consumers', 'Consumers', '消费者管理'],
    ['Plugin catalog', 'Plugin catalog', '插件目录'],
    ['Drafts', 'Drafts', '草稿箱'],
    ['Releases', 'Releases', '发布记录'],
    ['Audit log', 'Audit log', '操作审计'],
    ['Cluster connections', 'Cluster connections', '集群连接'],
  ];
  for (const [link, heading, chinese] of pages) {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: link, exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    const url = page.url();
    await switchTo(page, false);
    await expect(page.getByRole('heading', { level: 1, name: chinese, exact: true })).toBeVisible();
    expect(page.url()).toBe(url);
    await switchTo(page, true);
  }
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Cluster connections' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch color theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name: 'Switch language' })).toBeInViewport();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  await switchTo(page, false);
  expect(errors).toEqual([]);
});

test('英文插件目录支持双语检索、分类与文档，抽屉随其他标签页同步', async ({ page, context }) => {
  await open(page, '/plugins');
  const peer = await context.newPage();
  await open(peer, '/plugins');
  await switchTo(page, true);
  const search = page.getByRole('textbox', { name: 'Search plugins' });
  await search.fill('Authentication');
  await expect(page.getByRole('button', { name: 'View plugin basic-auth' })).toBeVisible();
  await search.fill('认证');
  await page.getByRole('button', { name: 'View plugin basic-auth' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Authentication', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'Official plugin documentation' })).toHaveAttribute(
    'href',
    'https://apisix.apache.org/docs/apisix/plugins/basic-auth/',
  );
  await expect(page.getByRole('link', { name: 'Visit website' })).toHaveAttribute(
    'href',
    'https://apisix.apache.org/plugins/',
  );
  await switchTo(peer, false);
  await expect(drawer.getByRole('link', { name: '官方插件文档' })).toHaveAttribute(
    'href',
    'https://apisix.apache.org/zh/docs/apisix/plugins/basic-auth/',
  );
  await expect(drawer.getByText('认证', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: '搜索插件' })).toHaveValue('认证');
});

test('路由输入与无效缓冲区跨语言保留，修正后保存的草稿和差异逐字段一致', async ({
  page,
  context,
}) => {
  await open(page, '/routes/new');
  const id = 'i18n-' + Date.now();
  let draftId = '';
  try {
    await page.getByLabel('资源 ID', { exact: true }).fill(id);
    await page.getByLabel('资源名称', { exact: true }).fill('路由管理');
    await page.getByLabel('资源说明', { exact: true }).fill('English 与中文 {0} $&');
    await page.getByLabel('匹配路径 URI', { exact: true }).fill('invalid-path');
    await expect(page.getByRole('alert').filter({ hasText: '路径需要以 / 开头' })).toBeVisible();
    await switchTo(page, true);
    await expect(page.getByLabel('Resource name', { exact: true })).toHaveValue('路由管理');
    await expect(page.getByLabel('Match URI', { exact: true })).toHaveValue('invalid-path');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Paths must start with /' }),
    ).toBeVisible();
    await page.getByLabel('Match URI', { exact: true }).fill('/' + id);
    const peer = await context.newPage();
    await open(peer, '/');
    const req = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/drafts') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).first().click();
    const response = await req;
    expect(response.ok()).toBe(true);
    const draft = await response.json();
    draftId = draft.id;
    const drawer = page.getByRole('dialog', { name: 'Draft diff preview' });
    await expect(drawer.getByRole('columnheader', { name: 'Target value / after' })).toBeVisible();
    expect(draft.after).toMatchObject({
      name: '路由管理',
      desc: 'English 与中文 {0} $&',
      uri: '/' + id,
    });
    await switchTo(peer, false);
    await expect(page.getByRole('dialog', { name: '草稿差异预览' })).toBeVisible();
    expect((await client.request('/drafts/' + draftId)).after).toEqual(draft.after);
  } finally {
    if (draftId) await client.request('/drafts/' + draftId, 'DELETE');
  }
});

test('消费者插件弹窗内切换语言，保留未提交的用户名和密钥，预览维持脱敏', async ({ page }) => {
  await open(page, '/consumers/new?plugin=basic-auth');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('username', { exact: true }).fill('local-i18n-user');
  await dialog.getByLabel('password', { exact: true }).fill('i18n-test-value');
  await switchTo(page, true, dialog);
  await expect(
    dialog.getByText('Configure consumer credentials or policies here', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('username', { exact: true })).toHaveValue('local-i18n-user');
  await expect(dialog.getByLabel('password', { exact: true })).toHaveValue('i18n-test-value');
  await expect(dialog.getByLabel('password', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Apply to consumer draft' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.editor-aside .config-preview')).toContainText('credential hidden');
  await expect(page.locator('.editor-aside .config-preview')).not.toContainText('i18n-test-value');
});

test('路由五个表单面板支持英文，JSON 编辑器切换语言时保留未完成的原文', async ({ page }) => {
  await open(page, '/routes/new');
  await switchTo(page, true);
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveCount(5);
  for (const tab of await tabs.all()) {
    await tab.click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText(/\p{Script=Han}/u);
  }
  await page.getByText('JSON editor', { exact: true }).click();
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('{"note":"未完成",');
  const error = page.getByText('Configuration must be a valid JSON object', { exact: true });
  await expect(error).toBeVisible();
  const before = await page.locator('.monaco-editor .view-lines').innerText();
  expect(before).toContain('未完成');
  await switchTo(page, false);
  await expect(page.getByText('配置必须是有效的 JSON 对象', { exact: true })).toBeVisible();
  expect(await page.locator('.monaco-editor .view-lines').innerText()).toBe(before);
});

test('集群连接表单原地切换并重译已显示的校验，真实连接检测结果可切换', async ({ page }) => {
  await open(page, '/clusters');
  await page.getByRole('button', { name: '接入集群', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存并检测' }).click();
  await expect(dialog.getByText('请输入集群名称', { exact: true })).toBeVisible();
  await switchTo(page, true, dialog);
  await expect(dialog.getByText('Enter a cluster name', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.selected-cluster').getByRole('button', { name: 'Test connection' }).click();
  await expect(
    page.getByText('Route configurations are accessible', { exact: true }),
  ).toBeVisible();
  await switchTo(page, false);
  await expect(page.getByText('可读取路由配置', { exact: true })).toBeVisible();
});

async function publishInEnglish(page: Page) {
  await page.getByRole('button', { name: 'Run pre-publish checks', exact: true }).click();
  await expect(page.getByText('Cluster write access', { exact: true })).toBeVisible();
  await expect(
    page.getByText('The editing baseline matches the current gateway configuration', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publish to gateway', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'I verified the target cluster and configuration diff' })
    .check();
  await page.getByRole('button', { name: 'Confirm publish', exact: true }).click();
  await expect(
    page.getByText('Configuration written and confirmed by Admin API read-back', { exact: true }),
  ).toBeVisible();
}

test('英文上游草稿经真实网关校验、发布、回读和回退', async ({ page }) => {
  const id = 'i18n-upstream-' + Date.now();
  await open(page, '/upstreams/new');
  await switchTo(page, true);
  try {
    await page.getByLabel('Resource name', { exact: true }).fill('上游管理');
    await page.getByLabel('Resource ID', { exact: true }).fill(id);
    await page.getByRole('button', { name: 'Add node', exact: true }).click();
    await page.getByLabel('Node address 1', { exact: true }).fill('echo:80');
    await page.getByRole('button', { name: 'Save draft', exact: true }).first().click();
    const diff = page.getByRole('dialog', { name: 'Draft diff preview' });
    await expect(diff.getByRole('columnheader', { name: 'Target value / after' })).toBeVisible();
    await diff.getByRole('button', { name: 'Create release', exact: true }).click();
    await page.getByLabel('Release title').fill('上游管理');
    await page.getByLabel('Reason for change').fill('原因保留原文');
    await page.getByRole('button', { name: 'Create and view diff' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: '上游管理', exact: true }),
    ).toBeVisible();
    expect((await client.gateway('/upstreams/' + id)).status).toBe(404);
    await publishInEnglish(page);
    const applied = await client.gateway('/upstreams/' + id);
    expect(applied.status).toBe(200);
    expect(applied.data.value.name).toBe('上游管理');
    await page.getByRole('button', { name: 'Create rollback', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Rollback · 上游管理' }),
    ).toBeVisible();
    await publishInEnglish(page);
    expect((await client.gateway('/upstreams/' + id)).status).toBe(404);
  } finally {
    await client.gateway('/upstreams/' + id, 'DELETE');
    for (const draft of await client.request('/drafts?cluster_id=' + clusterId))
      if (draft.resource_id === id && draft.status === 'draft')
        await client.request('/drafts/' + draft.id, 'DELETE');
  }
});

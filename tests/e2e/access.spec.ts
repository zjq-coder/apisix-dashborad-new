import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';
import type { Cluster } from '../../web/src/types';

let client: Awaited<ReturnType<typeof sandboxClient>>, dev: Cluster, stage: Cluster;
const accounts = new Set<string>();
const name = () => 'p0-ui-' + randomBytes(5).toString('hex');
test.beforeAll(async () => {
  client = await sandboxClient();
  const rows: Cluster[] = await client.request('/clusters');
  dev = rows.find((x) => x.url === 'http://apisix:9180/apisix/admin')!;
  stage = rows.find((x) => x.url === 'http://apisix-staging:9180/apisix/admin')!;
  expect(dev && stage).toBeTruthy();
});
test.afterEach(async () => {
  for (const a of await client.request('/users'))
    if (accounts.has(a.username))
      await client.request('/users/' + a.username, 'DELETE', { revision: a.revision });
  accounts.clear();
});
async function adminPage(p: Page, url: string) {
  const [n, v] = client.cookie.split('=');
  await p.context().addCookies([{ name: n, value: v, url: 'http://127.0.0.1:18080' }]);
  await p.goto(url);
}
async function signIn(p: Page, u: string, password: string) {
  await p.getByLabel('用户名', { exact: true }).fill(u);
  await p.getByLabel('密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录控制台' }).click();
}
test('管理员通过界面创建并编辑按集群独立的授权；中英文与小屏可用', async ({ page }) => {
  const username = name(),
    password = randomBytes(18).toString('hex');
  accounts.add(username);
  await adminPage(page, '/users');
  await expect(page.getByRole('heading', { name: '用户与权限' })).toBeVisible();
  await page.getByRole('button', { name: '添加账号' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('用户名', { exact: true }).fill(username);
  await form.getByLabel('登录密码', { exact: true }).fill(password);
  await form.getByRole('checkbox', { name: dev.name + ' 开发环境' }).check();
  await form.getByRole('checkbox', { name: dev.name + ' · 编辑草稿' }).check();
  await form.getByRole('button', { name: '保存权限' }).click();
  const row = page.getByRole('row').filter({ hasText: username });
  await expect(row).toContainText(dev.name);
  await row.getByRole('button', { name: '管理权限' }).click();
  await expect(form.getByLabel('重置密码', { exact: true })).toHaveValue('');
  await form.getByRole('checkbox', { name: dev.name + ' · 查看审计' }).check();
  await form.getByRole('button', { name: '保存权限' }).click();
  await expect(form).not.toBeVisible();
  const saved = (await client.request('/users')).find(
    (x: { username: string }) => x.username === username,
  );
  expect(saved.grants[dev.id]).toEqual(['audit', 'edit']);
  expect(Object.keys(saved.grants)).toEqual([dev.id]);
  await page.getByRole('button', { name: '切换语言', exact: true }).first().click();
  await page.getByText('English', { exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Users and permissions' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});
test('只读成员无法使用管理入口；改权后旧页面退出，重新登录只显示新环境', async ({ page }) => {
  const username = name(),
    password = randomBytes(18).toString('hex');
  accounts.add(username);
  const account = await client.request('/users', 'POST', {
    username,
    password,
    enabled: true,
    role: 'member',
    grants: { [dev.id]: [] },
  });
  await page.goto('/');
  await signIn(page, username, password);
  await expect(page.getByRole('button', { name: '新建路由' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '用户与权限' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '操作审计' })).toHaveCount(0);
  await page.goto('/users');
  await expect(page.getByText('没有此操作的权限', { exact: true })).toBeVisible();
  await page.goto('/routes?cluster=' + dev.id);
  await expect(page.getByRole('heading', { name: '路由管理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建路由' })).toBeDisabled();
  await client.request('/users/' + username, 'PUT', {
    username,
    enabled: true,
    role: 'member',
    revision: account.revision,
    grants: { [stage.id]: ['audit'] },
  });
  await page.getByRole('button', { name: '上游管理' }).click();
  await expect(page.getByRole('button', { name: '登录控制台' })).toBeVisible();
  await signIn(page, username, password);
  await expect(page.locator('.workspace-label')).toContainText(stage.name);
  await expect(page.getByRole('button', { name: '操作审计' })).toBeVisible();
  await page.getByRole('button', { name: '操作审计' }).click();
  await expect(page.getByRole('heading', { name: '操作审计' })).toBeVisible();
  await page.getByRole('combobox', { name: '审计范围' }).click();
  await expect(page.locator('.ant-select-dropdown:visible')).toContainText(stage.name);
  await expect(page.locator('.ant-select-dropdown:visible')).not.toContainText(dev.name);
});

test('审计页面可筛选成功的授权变更，并展开查看实际变更的集群权限', async ({ page }) => {
  const username = name();
  accounts.add(username);
  const account = await client.request('/users', 'POST', {
    username,
    password: randomBytes(18).toString('hex'),
    role: 'member',
    enabled: true,
    grants: { [dev.id]: [] },
  });
  await client.request('/users/' + username, 'PUT', {
    username,
    role: 'member',
    enabled: true,
    grants: { [stage.id]: ['audit'] },
    revision: account.revision,
  });
  await adminPage(page, '/audit');
  await page.getByRole('combobox', { name: '审计操作' }).click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('account.update', { exact: true })
    .click();
  await page.getByRole('combobox', { name: '操作结果' }).click();
  await page.locator('.ant-select-dropdown:visible').getByText('成功', { exact: true }).click();
  await page.getByRole('searchbox', { name: '筛选操作人' }).fill(client.session.username);
  await page.getByRole('searchbox', { name: '筛选操作人' }).press('Enter');
  const row = page.getByRole('row').filter({ hasText: username }).first();
  await expect(row).toContainText('account.update');
  await expect(row).toContainText('200');
  await row.locator('.ant-table-row-expand-icon').click();
  const detail = page.locator('.audit-grant-detail');
  await expect(detail.getByText('原授权').locator('..')).toContainText(dev.name);
  await expect(detail.getByText('新授权').locator('..')).toContainText(stage.name);
  await expect(detail).toContainText('查看审计');
});

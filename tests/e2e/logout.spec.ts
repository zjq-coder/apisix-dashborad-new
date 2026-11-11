import { test, expect, type Page } from '@playwright/test';
import { localConfig } from '../../scripts/sandbox-client.mjs';

async function signIn(page: Page) {
  const config = await localConfig();
  await page.getByLabel('用户名', { exact: true }).fill(config.DASHBOARD_USERNAME);
  await page.getByLabel('密码', { exact: true }).fill(config.DASHBOARD_PASSWORD);
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: '账户菜单' }).click();
  const result = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/logout') && r.request().method() === 'POST',
  );
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  return (await result).status();
}

test('账户菜单退出使旧会话失效，当前页和其他标签页都返回登录地址', async ({ page, context }) => {
  await page.goto('/routes');
  await signIn(page);
  await expect(page.getByRole('heading', { name: '路由管理' })).toBeVisible();
  await page.getByRole('button', { name: '上游管理' }).click();
  await expect(page.getByRole('heading', { name: '上游管理' })).toBeVisible();
  const peer = await context.newPage();
  await peer.goto('/routes/new');
  await peer.getByLabel('资源名称', { exact: true }).fill('logout-regression-unsaved');
  expect(await signOut(page)).toBe(200);
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  for (const tab of [page, peer]) {
    await expect(tab).toHaveURL(/\/login$/);
    await expect(tab.getByRole('button', { name: '登录控制台' })).toBeVisible();
    await expect(tab.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  }
  await page.reload();
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: '登录控制台' })).toBeVisible();
});

test('注销失败时显示可重试提示，重试成功后可重新登录工作台', async ({ page }) => {
  await page.goto('/login');
  await signIn(page);
  await page.route(
    '**/api/v1/logout',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: '服务暂时不可用' },
      }),
    { times: 1 },
  );
  expect(await signOut(page)).toBe(503);
  await expect(page.getByRole('alert')).toContainText('退出登录失败，请重试');
  expect((await page.request.get('/api/v1/session')).status()).toBe(200);
  expect(await signOut(page)).toBe(200);
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page);
  await expect(page.getByRole('heading', { name: '配置工作台' })).toBeVisible();
});

test('服务端会话已经失效时点击退出仍能返回登录页', async ({ page }) => {
  await page.goto('/login');
  await signIn(page);
  await expect(page.getByRole('heading', { name: '配置工作台' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const session = await (await page.request.get('/api/v1/session')).json();
  const revoked = await page.request.post('/api/v1/logout', {
    headers: { 'X-CSRF-Token': session.csrf_token },
  });
  expect(revoked.status()).toBe(200);
  expect(await signOut(page)).toBe(401);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: '登录控制台' })).toBeVisible();
});

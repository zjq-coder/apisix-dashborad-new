import { test, expect } from '@playwright/test';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';
test('运维页面创建与查看已发布的共享策略、导入配置预览、离线诊断及英文导航', async ({ page }) => {
  const { config, request, waitChange, gateway } = await sandboxClient();
  const dev = (await request('/clusters')).find(
    (c: { url: string }) => c.url === 'http://apisix:9180/apisix/admin',
  );
  const id = 'p1-ui-' + Date.now();
  let transferId = '';
  try {
    await page.goto('/policies?cluster=' + dev.id);
    await page.getByLabel('用户名', { exact: true }).fill(config.DASHBOARD_USERNAME);
    await page.getByLabel('密码', { exact: true }).fill(config.DASHBOARD_PASSWORD);
    await page.getByRole('button', { name: '登录控制台' }).click();
    await page.getByRole('button', { name: '新建配置' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('资源 ID', { exact: true }).fill(id);
    await dialog
      .getByLabel('完整 JSON 配置', { exact: true })
      .fill(JSON.stringify({ desc: 'UI check', plugins: { 'key-auth': {} } }));
    await dialog.getByRole('button', { name: '编辑插件 key-auth' }).click();
    const applied = page.waitForResponse(
      (r) => r.url().endsWith('/plugins/key-auth/validate') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '应用到配置' }).click();
    expect((await applied).status()).toBe(200);
    await dialog.getByRole('button', { name: '校验配置' }).click();
    await expect(dialog.getByText('目标网关 Schema 与插件配置校验通过')).toBeVisible();
    const save = page.waitForResponse(
      (r) => r.url().endsWith('/config/apply') && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: '保存并发布' }).click();
    expect((await waitChange((await (await save).json()).id)).status).toBe('succeeded');
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole('row')
      .filter({ hasText: id })
      .getByRole('button', { name: '编辑' })
      .click();
    await expect(page.getByLabel('完整 JSON 配置', { exact: true })).toContainText('UI check');
    await page.goto('/transfer?cluster=' + dev.id);
    const bundle = {
      format: 'apisix-dashboard/v1',
      items: [{ kind: 'upstreams', id, value: { nodes: { 'echo:80': 1 } } }],
    };
    await page.locator('input[type=file]').setInputFiles({
      name: 'bundle.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await page.getByRole('button', { name: '预览目标差异' }).click();
    await expect(page.getByRole('button', { name: '批量发布' })).toBeEnabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出配置包' }).click();
    expect((await download).suggestedFilename()).toBe('apisix-config.json');
    const staged = page.waitForResponse(
      (r) => r.url().endsWith('/transfer/apply') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '批量发布' }).click();
    transferId = (await (await staged).json()).id;
    expect((await waitChange(transferId)).status).toBe('succeeded');
    await page.getByRole('button', { name: '查看发布记录' }).click();
    await expect(page).toHaveURL(new RegExp('/changes/' + transferId));
    expect(new URL(page.url()).searchParams.get('cluster')).not.toBe(dev.id);
    await page.goto('/diagnostics?cluster=' + dev.id);
    await page.getByLabel('请求路径', { exact: true }).fill('/health');
    await page.getByRole('button', { name: '分析路由' }).click();
    const health = (await request('/clusters/' + dev.id + '/resources/routes')).items.find(
      (r: { value: { uri: string } }) => r.value.uri === '/health',
    );
    await expect(page.getByText(health.id, { exact: true })).toBeVisible();
    if (health.value.name)
      await expect(page.getByText(health.value.name, { exact: true })).toBeVisible();
    await page.evaluate(() => localStorage.setItem('console.locale', 'en-US'));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Configuration diagnostics' })).toBeVisible();
    await page.getByRole('button', { name: 'Extended resources', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Stream routes' })).toBeVisible();
  } finally {
    if (transferId) {
      const undo = await request('/changesets/' + transferId + '/rollback', 'POST', {});
      await request('/changesets/' + undo.id + '/publish', 'POST', {});
      expect((await waitChange(undo.id)).status).toBe('succeeded');
    }
    await gateway('/plugin_configs/' + id, 'DELETE');
  }
});

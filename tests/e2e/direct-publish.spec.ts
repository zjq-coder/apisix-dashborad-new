import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';
import type { Cluster } from '../../web/src/types';

test('编辑员直接提交、管理员发布和一键回退，全程不产生草稿', async ({ page }) => {
  const admin = await sandboxClient();
  const dev = (await admin.request('/clusters')).find(
    (c: Cluster) => c.environment === 'development' && c.url === 'http://apisix:9180/apisix/admin',
  );
  expect(dev?.read_only).toBe(false);
  const id = 'direct-ui-' + randomBytes(5).toString('hex');
  const password = randomBytes(24).toString('hex');
  const account = await admin.request('/users', 'POST', {
    username: id,
    password,
    role: 'member',
    enabled: true,
    grants: { [dev.id]: ['edit'] },
  });
  const route = '/routes/' + id;
  try {
    expect(
      (
        await admin.gateway(route, 'PUT', {
          uri: route,
          name: id,
          desc: 'before',
          upstream_id: 'sandbox-orders',
        })
      ).status,
    ).toBeLessThan(300);
    await page.goto('/routes/' + id + '/edit?cluster=' + dev.id);
    await page.getByLabel('用户名', { exact: true }).fill(id);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录控制台' }).click();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await page.goto('/routes/' + id + '/edit?cluster=' + dev.id);
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') writes.push(new URL(r.url()).pathname);
    });
    await page.getByLabel('资源说明', { exact: true }).fill('after');
    await page.getByRole('button', { name: '校验当前配置' }).last().click();
    await expect(page.locator('.diff-view')).toContainText('/desc');
    await expect(page.locator('.diff-view')).toContainText('before');
    await expect(page.locator('.diff-view')).toContainText('after');
    await page.getByRole('button', { name: '提交变更', exact: true }).first().click();
    await expect(page).toHaveURL(/\/changes\/[^?]+\?cluster=/);
    const changeId = new URL(page.url()).pathname.split('/').pop();
    await expect(page.getByRole('button', { name: '发布到网关', exact: true })).toBeDisabled();
    expect((await admin.gateway(route)).data.value.desc).toBe('before');
    const [name, value] = admin.cookie.split('=');
    await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
    await page.reload();
    await page.getByRole('button', { name: '发布到网关', exact: true }).click();
    await page.getByRole('checkbox', { name: '我已核对目标集群与配置差异' }).check();
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    await expect.poll(async () => (await admin.gateway(route)).data.value.desc).toBe('after');
    await page.getByRole('button', { name: '回退已应用配置', exact: true }).click();
    await page.getByRole('checkbox', { name: '我已核对目标集群与配置差异' }).check();
    await page.getByRole('button', { name: '确认回退', exact: true }).click();
    await expect.poll(async () => (await admin.gateway(route)).data.value.desc).toBe('before');
    await expect(page.getByText('配置已写入，并通过 Admin API 回读确认')).toBeVisible();
    expect((await admin.request('/changesets/' + changeId)).operations[0].draft_id).toBe('');
    expect(writes.some((p) => p.includes('/drafts'))).toBe(false);
    const entry = await admin.request('/clusters/' + dev.id + '/resources/routes/' + id);
    const legacy = await admin.request('/drafts', 'POST', {
      cluster_id: dev.id,
      resource_type: 'routes',
      resource_id: id,
      action: 'delete',
      base_hash: entry.hash,
    });
    await page.goto('/drafts?preview=' + legacy.id + '&cluster=' + dev.id);
    await page
      .getByRole('dialog', { name: '草稿差异预览' })
      .getByRole('button', { name: '确认删除' })
      .click();
    await expect.poll(async () => (await admin.gateway(route)).status).toBe(404);
    await expect
      .poll(async () => (await admin.request('/drafts/' + legacy.id)).status)
      .toBe('published');
  } finally {
    for (const d of await admin.request('/drafts?cluster_id=' + dev.id))
      if (d.resource_id === id && d.status === 'draft')
        await admin.request('/drafts/' + d.id, 'DELETE');
    await admin.gateway(route, 'DELETE');
    await admin.request('/users/' + id, 'DELETE', { revision: account.revision });
  }
});

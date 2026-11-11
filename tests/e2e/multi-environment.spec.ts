import { expect, test, type Page } from '@playwright/test';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';

type Cluster = { id: string; name: string; environment: string; url: string };
let client: Awaited<ReturnType<typeof sandboxClient>>;
let dev: Cluster, staging: Cluster;
test.beforeAll(async () => {
  client = await sandboxClient();
  const clusters: Cluster[] = await client.request('/clusters');
  const second = clusters.find(
    (c) => c.url === 'http://apisix-staging:9180/apisix/admin' && c.environment === 'staging',
  );
  test.skip(!second, 'Start and register the optional local staging sandbox first.');
  staging = second!;
  dev = clusters.find(
    (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  )!;
  expect(dev).toBeTruthy();
});

async function start(page: Page) {
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto('/routes?cluster=' + dev.id);
  await expect(page.getByRole('button', { name: 'health-check', exact: true })).toBeVisible();
}
async function selectCluster(page: Page, target: Cluster) {
  await page.getByRole('combobox', { name: '当前集群' }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .getByText(target.name, { exact: true })
    .click();
}
function envBadge(page: Page) {
  return page.locator('.topbar-actions > .ant-tag');
}
async function requestAt(port: number, path: string) {
  return fetch('http://127.0.0.1:' + port + path, { signal: AbortSignal.timeout(4000) });
}
async function publish(page: Page) {
  await page.getByRole('button', { name: '执行发布前校验', exact: true }).click();
  await page.getByRole('button', { name: '发布到网关', exact: true }).click();
  await page.getByRole('checkbox', { name: '我已核对目标集群与配置差异' }).check();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(
    page.getByText('配置已写入，并通过 Admin API 回读确认', { exact: true }),
  ).toBeVisible();
}

test('两个真实环境双向切换，路由和上游列表、URL、环境标签及刷新记忆一致', async ({ page }) => {
  await start(page);
  const marker = page.getByRole('button', { name: 'staging-env-check', exact: true });
  const health = page.getByRole('button', { name: 'health-check', exact: true });
  await expect(marker).toHaveCount(0);
  await selectCluster(page, staging);
  await expect(marker).toBeVisible();
  await expect(health).toHaveCount(0);
  await expect(envBadge(page)).toHaveText('测试环境');
  expect(new URL(page.url()).searchParams.get('cluster')).toBe(staging.id);
  await page.reload();
  await expect(marker).toBeVisible();
  await page.goto('/routes');
  await expect(marker).toBeVisible();
  await page.getByRole('button', { name: '上游管理', exact: true }).click();
  await expect(page.getByRole('button', { name: 'staging-echo', exact: true })).toBeVisible();
  await selectCluster(page, dev);
  await expect(page.getByRole('button', { name: 'orders-service', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'staging-echo', exact: true })).toHaveCount(0);
  await expect(envBadge(page)).toHaveText('开发环境');
  expect(new URL(page.url()).searchParams.get('cluster')).toBe(dev.id);
  await page.getByRole('button', { name: '路由管理', exact: true }).click();
  await expect(health).toBeVisible();
  await expect(marker).toHaveCount(0);
});

test('跨环境切换可取消或放弃未保存编辑', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: '新建路由', exact: true }).click();
  await page.getByLabel('资源名称', { exact: true }).fill('未保存的环境切换检查');
  await selectCluster(page, staging);
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('资源名称', { exact: true })).toHaveValue('未保存的环境切换检查');
  expect(new URL(page.url()).searchParams.get('cluster')).toBe(dev.id);
  await selectCluster(page, staging);
  await page.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await expect(page.getByRole('button', { name: 'staging-env-check', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建路由', exact: true }).click();
  await expect(page.getByLabel('资源名称', { exact: true })).toHaveValue('');
  expect(new URL(page.url()).searchParams.get('cluster')).toBe(staging.id);
});

test('选中测试环境后保存草稿、发布和回退，只影响对应的真实网关', async ({ page }) => {
  const id = 'env-switch-' + crypto.randomUUID().slice(0, 12);
  const path = '/__env/' + id;
  let draftId = '',
    changeId = '';
  await start(page);
  await selectCluster(page, staging);
  await expect(page.getByRole('button', { name: 'staging-env-check', exact: true })).toBeVisible();
  try {
    await page.getByRole('button', { name: '新建路由', exact: true }).click();
    await page.getByLabel('资源名称', { exact: true }).fill(id);
    await page.getByLabel('资源 ID', { exact: true }).fill(id);
    await page.getByLabel('匹配路径 URI', { exact: true }).fill(path);
    await page.getByRole('tab', { name: '上游服务' }).click();
    await page.getByLabel('选择上游', { exact: true }).click();
    await page.getByTitle('staging-echo · staging-echo', { exact: true }).click();
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/drafts') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
    const draft = await (await saved).json();
    draftId = draft.id;
    expect(draft.cluster_id).toBe(staging.id);
    const devDrafts = await client.request('/drafts?cluster_id=' + dev.id);
    expect(devDrafts.some((d: { id: string }) => d.id === draftId)).toBe(false);
    for (const port of [19080, 29080]) expect((await requestAt(port, path)).status).toBe(404);
    const drawer = page.getByRole('dialog', { name: '草稿差异预览' });
    await drawer.getByRole('button', { name: '创建发布变更', exact: true }).click();
    await page.getByLabel('变更说明').fill('验证实际网关按所选环境发布与回退');
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/changesets') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '创建并查看差异' }).click();
    const change = await (await created).json();
    changeId = change.id;
    expect(change.cluster_id).toBe(staging.id);
    await publish(page);
    await expect.poll(async () => (await requestAt(29080, path)).status).toBe(200);
    expect(await (await requestAt(29080, path)).json()).toEqual({
      environment: 'staging',
      service: 'echo-staging',
    });
    expect((await requestAt(19080, path)).status).toBe(404);
    expect((await client.gateway('/routes/' + id)).status).toBe(404);
    await page.getByRole('button', { name: '生成回退变更', exact: true }).click();
    await expect(
      page.getByText('这是一个新的回退变更，尚需校验和发布。', { exact: true }),
    ).toBeVisible();
    await publish(page);
    await expect.poll(async () => (await requestAt(29080, path)).status).toBe(404);
    expect((await requestAt(19080, path)).status).toBe(404);
  } finally {
    if (changeId) {
      const change = await client.waitChange(changeId);
      const { items } = await client.request('/clusters/' + staging.id + '/resources/routes');
      if (change.status === 'succeeded' && items.some((r: { id: string }) => r.id === id)) {
        const undo = await client.request('/changesets/' + changeId + '/rollback', 'POST', {});
        await client.request('/changesets/' + undo.id + '/publish', 'POST', {});
        expect((await client.waitChange(undo.id)).status).toBe('succeeded');
      } else if (change.status === 'pending')
        await client.request('/changesets/' + changeId + '/cancel', 'POST', {});
    }
    if (draftId && (await client.request('/drafts/' + draftId)).status === 'draft')
      await client.request('/drafts/' + draftId, 'DELETE');
  }
});

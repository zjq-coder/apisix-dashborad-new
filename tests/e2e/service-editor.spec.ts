import { expect, test, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { sandboxClient } from '../../scripts/sandbox-client.mjs';
import type { Cluster } from '../../web/src/types';

test('切换本地开发和预发集群后，上游候选与当前环境一致', async ({ page }) => {
  const { dev, clusters, gateway, id, dialog } = await setup(page);
  const staging = clusters.find(
    (c) => c.url === 'http://apisix-staging:9180/apisix/admin' && c.environment === 'staging',
  );
  test.skip(!staging, '需要已接入的本地预发环境');
  const path = '/upstreams/' + id;
  try {
    expect(
      (await gateway(path, 'PUT', { name: 'Development only', nodes: { 'echo:80': 1 } })).status,
    ).toBeLessThan(300);
    for (const cluster of [dev, staging!, dev]) {
      if (!page.url().includes(cluster.id)) {
        await page.getByRole('combobox', { name: '当前集群' }).click();
        await page
          .locator('.ant-select-dropdown:visible')
          .getByText(cluster.name, { exact: true })
          .click();
      }
      await page.getByRole('button', { name: '新建配置' }).click();
      await dialog.getByRole('tab', { name: '上游服务' }).click();
      await dialog.getByRole('combobox', { name: '选择上游' }).fill(id);
      if (cluster === dev)
        await expect(
          page
            .locator('.ant-select-item-option-content')
            .getByText('Development only · ' + id, { exact: true }),
        ).toBeVisible();
      else await expect(page.getByText('未找到匹配的上游', { exact: true })).toBeVisible();
      await dialog.getByRole('combobox', { name: '选择上游' }).press('Escape');
      await dialog.locator('.ant-modal-close').click();
      await expect(dialog).toBeHidden();
    }
  } finally {
    await gateway(path, 'DELETE');
    expect((await gateway(path)).status).toBe(404);
  }
});

async function setup(page: Page, english = false) {
  const client = await sandboxClient();
  const clusters: Cluster[] = await client.request('/clusters');
  const dev = clusters.find(
    (c) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  )!;
  expect(dev?.read_only).toBe(false);
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  if (english) await page.addInitScript(() => localStorage.setItem('console.locale', 'en-US'));
  await page.goto('/extended?kind=services&cluster=' + dev.id);
  const id = 'svc-ui-' + randomUUID().slice(0, 8);
  return {
    ...client,
    dev,
    clusters,
    id,
    dialog: page.getByRole('dialog', { name: english ? /Service/i : /服务/ }),
  };
}

test('服务从筛选上游、设置域名和插件到真实转发，再切换内联节点和健康检查', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { gateway, id, dialog } = await setup(page);
  const host = id + '.example.test';
  const upstreamId = id + '-pool';
  const alternate = id + '-alternate';
  const servicePath = '/services/' + id;
  const routePath = '/routes/' + id;
  const proxyUrl = 'http://127.0.0.1:19080/__inspect/' + id;
  const save = dialog.getByRole('button', { name: '保存并发布' });
  const config = async () => (await gateway(servicePath)).data.value;
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const checkProxy = async (expectedHost: string) => {
    await expect
      .poll(async () => {
        const res = await request.get(proxyUrl, { headers: { Host: host } });
        return [res.status(), (await res.text()).includes('host=' + expectedHost + '\n')];
      })
      .toEqual([201, true]);
  };
  try {
    expect(
      (
        await gateway('/upstreams/' + alternate, 'PUT', {
          name: 'Orders West',
          nodes: { 'echo:80': 1 },
        })
      ).status,
    ).toBeLessThan(300);
    expect(
      (
        await gateway('/upstreams/' + upstreamId, 'PUT', {
          name: 'Orders West',
          nodes: { 'echo:80': 1 },
          pass_host: 'rewrite',
          upstream_host: 'shared.example.test',
        })
      ).status,
    ).toBeLessThan(300);
    await page.getByRole('button', { name: '新建配置' }).click();
    await dialog.getByLabel('资源 ID', { exact: true }).fill(id);
    await dialog.getByLabel('服务名称', { exact: true }).fill('Orders API');
    await dialog.getByLabel('服务描述').fill('服务转发验收');
    await dialog.getByRole('button', { name: '添加域名' }).click();
    await dialog.getByLabel('域名', { exact: true }).fill(host);
    await dialog.getByRole('switch', { name: 'WebSocket' }).click();
    await dialog.getByRole('tab', { name: '上游服务' }).click();
    const search = dialog.getByRole('combobox', { name: '选择上游' });
    await search.fill('orders west');
    const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
    await expect(options.filter({ hasText: upstreamId })).toHaveCount(1);
    await expect(options.filter({ hasText: alternate })).toHaveCount(1);
    await search.fill('no-match-' + id);
    await expect(page.getByText('未找到匹配的上游', { exact: true })).toBeVisible();
    await search.fill(upstreamId);
    await expect(options).toHaveCount(1);
    await page.screenshot({
      path: '.local/screenshots/service-upstream-search.png',
      animations: 'disabled',
    });
    await options.click();
    await expect(dialog.locator('.service-target-summary')).toContainText('1 个节点');
    await dialog.screenshot({
      path: '.local/screenshots/service-upstream-selected.png',
      animations: 'disabled',
    });
    await dialog.getByRole('tab', { name: '插件配置' }).click();
    await dialog.getByRole('button', { name: '添加插件', exact: true }).click();
    await page.getByPlaceholder('搜索插件名称或用途').fill('response-rewrite');
    await page.locator('.plugin-picker button').filter({ hasText: 'response-rewrite' }).click();
    await page.getByRole('spinbutton', { name: 'status_code', exact: true }).fill('201');
    await page.getByRole('button', { name: '应用到配置' }).click();
    await dialog.getByRole('tab', { name: '配置预览' }).click();
    await expect(dialog.locator('.service-json')).toContainText(upstreamId);
    await dialog.getByRole('button', { name: '校验配置' }).click();
    await expect(dialog.locator('.diff-view')).toContainText('upstream_id');
    await save.click();
    await expect(dialog).toBeHidden();
    expect(await config()).toMatchObject({
      name: 'Orders API',
      desc: '服务转发验收',
      hosts: [host],
      enable_websocket: true,
      upstream_id: upstreamId,
      plugins: { 'response-rewrite': { status_code: 201 } },
    });
    expect(
      (await gateway(routePath, 'PUT', { uri: '/__inspect/' + id, service_id: id })).status,
    ).toBeLessThan(300);
    await checkProxy('shared.example.test');
    await page.getByPlaceholder('搜索资源 ID 或名称').fill(id);
    const row = page.getByRole('row').filter({ hasText: id });
    await expect(row).toContainText('Orders API');
    await expect(row).toContainText('服务转发验收');
    await row.getByRole('button', { name: '编辑' }).click();
    await dialog.getByRole('tab', { name: '上游服务' }).click();
    await expect(dialog.getByText('Orders West · ' + upstreamId, { exact: true })).toBeVisible();
    await dialog.getByText('内联上游', { exact: true }).click();
    await dialog.getByRole('button', { name: '添加节点' }).click();
    await expect(save).toBeDisabled();
    await dialog.getByLabel('节点地址 1', { exact: true }).fill('echo:80');
    await dialog.getByLabel('转发 Host', { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible')
      .getByText('指定 Host', { exact: true })
      .click();
    await dialog.getByLabel('指定上游 Host', { exact: true }).fill('inline.example.test');
    await dialog.getByLabel('重试次数', { exact: true }).fill('2');
    await dialog.getByLabel('重试总超时（秒）', { exact: true }).fill('3');
    for (const label of ['连接超时（秒）', '发送超时（秒）', '读取超时（秒）'])
      await dialog.getByLabel(label, { exact: true }).fill('5');
    await dialog.getByRole('switch', { name: '自定义连接池' }).click();
    await dialog.getByLabel('连接池容量', { exact: true }).fill('64');
    await dialog.getByRole('switch', { name: '主动健康检查' }).click();
    await dialog.getByRole('switch', { name: '被动健康检查' }).click();
    await dialog.getByText('引用已有上游', { exact: true }).click();
    await expect(dialog.getByText('Orders West · ' + upstreamId, { exact: true })).toBeVisible();
    await dialog.getByText('内联上游', { exact: true }).click();
    await expect(dialog.getByLabel('节点地址 1', { exact: true })).toHaveValue('echo:80');
    await dialog.getByRole('button', { name: '校验配置' }).click();
    await expect(dialog.locator('.diff-view')).toContainText('/upstream_id');
    await save.click();
    await expect(dialog).toBeHidden();
    const applied = await config();
    expect(applied).not.toHaveProperty('upstream_id');
    expect(applied.upstream).toMatchObject({
      nodes: { 'echo:80': 1 },
      retries: 2,
      retry_timeout: 3,
      timeout: { connect: 5, send: 5, read: 5 },
      keepalive_pool: { size: 64 },
      checks: { active: { http_path: '/health' }, passive: { type: 'http' } },
    });
    await checkProxy('inline.example.test');
    expect(pageErrors).toEqual([]);
  } finally {
    for (const path of [
      routePath,
      servicePath,
      '/upstreams/' + upstreamId,
      '/upstreams/' + alternate,
    ]) {
      await gateway(path, 'DELETE');
      expect((await gateway(path)).status).toBe(404);
    }
  }
});

test('服务表单阻止未完成的输入和无效 JSON，支持无上游的旧服务和英文编辑', async ({ page }) => {
  const { gateway, id, dialog } = await setup(page, true);
  const path = '/services/' + id;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    expect(
      (await gateway(path, 'PUT', { labels: { team: 'ops' }, plugins: { cors: {} } })).status,
    ).toBeLessThan(300);
    await page.reload();
    await page.getByPlaceholder('Search by resource ID or name').fill(id);
    await page
      .getByRole('row')
      .filter({ hasText: id })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Add Host', exact: true }).click();
    const save = dialog.getByRole('button', { name: 'Save and publish', exact: true });
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole('tab', { name: 'Configuration preview' })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('svc.example');
    await dialog.getByRole('tab', { name: 'Upstream services' }).click();
    await expect(dialog.getByRole('radio', { name: 'Set on the route' })).toBeChecked();
    await dialog.getByRole('tab', { name: 'Configuration preview' }).click();
    await dialog.getByRole('button', { name: 'JSON editor' }).click();
    const json = dialog.getByLabel('Full JSON configuration', { exact: true });
    const original = JSON.parse(await json.inputValue());
    await json.fill('{');
    await expect(save).toBeDisabled();
    await json.fill(JSON.stringify({ ...original, hosts: 'svc.example' }));
    await expect(dialog.getByRole('tab', { name: 'Basic information' })).toBeDisabled();
    await json.fill(JSON.stringify({ ...original, upstream_id: id + '-missing' }));
    const validate = dialog.getByRole('button', { name: 'Validate configuration', exact: true });
    let capture!: (route: Route) => void;
    const intercepted = new Promise<Route>((resolve) => {
      capture = resolve;
    });
    await page.route('**/api/v1/clusters/*/validate', capture, { times: 1 });
    await validate.click();
    const validationRequest = await intercepted;
    try {
      await expect(validate).toHaveAttribute('aria-busy', 'true');
      await expect(save).toHaveAttribute('aria-busy', 'false');
      await expect(save).toBeDisabled();
    } finally {
      await validationRequest.continue();
    }
    await expect(dialog.locator('.check-row.fail')).toContainText(id + '-missing');
    await dialog.getByRole('tab', { name: 'Upstream services' }).click();
    await expect(
      dialog.getByText(
        'Upstream ' + id + '-missing is missing from this cluster. Select another upstream.',
      ),
    ).toBeVisible();
    await dialog.getByText('Set on the route', { exact: true }).click();
    await save.click();
    await expect(dialog).toBeHidden();
    const restored = (await gateway(path)).data.value;
    expect(restored).toMatchObject({
      labels: { team: 'ops' },
      hosts: ['svc.example'],
      plugins: { cors: {} },
    });
    expect(restored).not.toHaveProperty('upstream_id');
    expect(restored).not.toHaveProperty('name');
    expect(errors).toEqual([]);
  } finally {
    await gateway(path, 'DELETE');
    expect((await gateway(path)).status).toBe(404);
  }
});

import { test, expect, type Page } from '@playwright/test';
import { sandboxClient, sandboxProxy } from '../../scripts/sandbox-client.mjs';

async function setup(page: Page, suffix: string) {
  const client = await sandboxClient();
  const cluster = (await client.request('/clusters')).find(
    (c: any) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  );
  expect(cluster).toBeTruthy();
  const id = `route-ui-${Date.now()}-${suffix}`;
  const [name, value] = client.cookie.split('=');
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await page.goto(`/routes/new?cluster=${cluster.id}`);
  await page.getByLabel('资源 ID', { exact: true }).fill(id);
  await page.getByLabel('资源名称', { exact: true }).fill('订单 API · 高级路由验收');
  const cleanup = async () => {
    await client.gateway(`/routes/${id}`, 'DELETE');
    for (const d of await client.request(`/drafts?cluster_id=${cluster.id}`))
      if (d.resource_id === id && d.status === 'draft')
        await client.request(`/drafts/${d.id}`, 'DELETE');
  };
  return { client, cluster, id, cleanup };
}
async function choose(page: Page, label: string, option: string) {
  const control = page.getByLabel(label, { exact: true });
  await control.click();
  const listId = await control.getAttribute('aria-controls');
  const popup = page
    .locator('.ant-select-dropdown')
    .filter({ has: page.locator(`[id="${listId}"]`) });
  await popup.locator('.ant-select-item-option-content').getByText(option, { exact: true }).click();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
}
async function config(page: Page) {
  return JSON.parse(await page.locator('.editor-aside .config-preview').innerText());
}
async function json(page: Page, value: unknown) {
  await page.getByText('JSON 编辑', { exact: true }).click();
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+A');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    JSON.stringify(value, null, 2),
  );
  await page.keyboard.press('Control+V');
  await expect(page.locator('.editor-aside .config-preview')).toHaveText(
    JSON.stringify(value, null, 2),
  );
}
async function save(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/drafts') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(page.getByRole('dialog', { name: '草稿差异预览' })).toBeVisible();
  return result.json();
}
async function release(client: any, draft: any) {
  const change = await client.request('/changesets', 'POST', {
    draft_ids: [draft.id],
    title: '高级路由浏览器验收',
    reason: '本地隔离网关自动化测试',
  });
  const validation = await client.request(`/changesets/${change.id}/validate`, 'POST', {});
  expect(validation.ok, JSON.stringify(validation.checks)).toBe(true);
  await client.request(`/changesets/${change.id}/publish`, 'POST', {});
  const result = await client.waitChange(change.id);
  expect(
    result.status,
    JSON.stringify(result.operations.map((o: any) => ({ status: o.status, error: o.error }))),
  ).toBe('succeeded');
  return change;
}

test('集群切换确认放弃编辑，目标只读集群禁止新建与修改', async ({ page }) => {
  const { client, cluster, cleanup } = await setup(page, 'cluster-switch');
  try {
    const clusters = await client.request('/clusters');
    const other = {
      ...cluster,
      id: 'preview-readonly-cluster',
      name: '对照只读集群',
      environment: 'staging',
      read_only: true,
    };
    await page.route('**/api/v1/clusters', (route) =>
      route.fulfill({ json: [...clusters, other] }),
    );
    await page.route('**/api/v1/clusters/preview-readonly-cluster/**', (route) =>
      route.fulfill({
        json: /\/plugins(?:\/catalog)?$/.test(route.request().url()) ? [] : { items: [], total: 0 },
      }),
    );
    await page.reload();
    await page.getByLabel('资源名称', { exact: true }).fill('前一个集群的临时路由');
    await page.getByLabel('匹配路径 URI', { exact: true }).fill('/previous-cluster');
    await choose(page, '当前集群', '对照只读集群');
    await page.getByRole('button', { name: '放弃修改并离开' }).click();
    await expect(page).toHaveURL(/\/routes\?cluster=preview-readonly-cluster/);
    await expect(page.getByRole('button', { name: '新建路由', exact: true })).toBeDisabled();
    await page.goto('/routes/new?cluster=preview-readonly-cluster');
    await expect(page.getByLabel('资源名称', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('匹配路径 URI', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('资源名称', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '保存草稿', exact: true }).first(),
    ).toBeDisabled();
  } finally {
    await cleanup();
  }
});

test('可视化复杂路由：多条件、内联健康检查、请求改写、发布和实际流量', async ({ page }) => {
  test.setTimeout(120_000);
  const { client, cluster, id, cleanup } = await setup(page, 'complex');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page
      .getByLabel('资源说明')
      .fill('按租户与版本匹配，转发到订单服务，保留完整发布审查记录。');
    await page.getByRole('button', { name: '添加标签', exact: true }).click();
    await page.getByLabel('标签名称 1').fill('team');
    await page.getByLabel('标签值 1').fill('platform');
    await page.getByLabel('匹配路径 URI', { exact: true }).fill(`/${id}/*`);
    await page.getByRole('button', { name: '添加匹配路径 URI', exact: true }).click();
    await page.getByLabel('匹配路径 URI 2', { exact: true }).fill(`/${id}-alternate/*`);
    for (const [label, values] of [
      ['域名 Host', ['console.test', 'alternate.test']],
      ['客户端地址', ['0.0.0.0/0', '::/0']],
    ] as const) {
      for (let i = 0; i < values.length; i++) {
        await page.getByRole('button', { name: `添加${label}`, exact: true }).click();
        await page.getByLabel(`${label}${i ? ' ' + (i + 1) : ''}`, { exact: true }).fill(values[i]);
      }
    }
    await page.getByLabel('匹配优先级', { exact: true }).fill('25');
    await page.getByRole('switch', { name: 'WebSocket', exact: true }).click();
    await page.getByRole('button', { name: '添加条件', exact: true }).click();
    await page.getByLabel('条件 1 参数名称', { exact: true }).fill('version');
    await page.getByLabel('条件 1 参数值', { exact: true }).fill('v2');
    await page.getByRole('button', { name: '添加条件组', exact: true }).click();
    await choose(page, '条件 2 1 参数位置', 'HTTP 请求头');
    await page.getByLabel('条件 2 1 参数名称', { exact: true }).fill('x-tenant');
    await page.getByLabel('条件 2 1 参数值', { exact: true }).fill('platform');
    await choose(page, '条件 2 2 参数位置', 'Cookie');
    await page.getByLabel('条件 2 2 参数名称', { exact: true }).fill('team');
    await page.getByLabel('条件 2 2 参数值', { exact: true }).fill('platform');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: '.local/screenshots/v3-route-match.png',
      fullPage: true,
      animations: 'disabled',
    });

    await page.getByRole('tab', { name: '上游服务' }).click();
    await choose(page, '上游来源', '内联上游 · 在路由内配置');
    await choose(page, '负载均衡算法', '一致性哈希 · Chash');
    await page.getByLabel('哈希键', { exact: true }).fill('remote_addr');
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
    await page.getByLabel('节点地址 1', { exact: true }).fill('echo:80');
    await page.getByLabel('节点优先级 1', { exact: true }).fill('0');
    await page.getByLabel('重试次数', { exact: true }).fill('0');
    await page.getByLabel('重试总超时（秒）', { exact: true }).fill('0');
    await page.getByRole('switch', { name: '自定义连接池', exact: true }).click();
    await page.getByRole('switch', { name: '主动健康检查', exact: true }).click();
    await page.getByLabel('检查路径', { exact: true }).fill('/health');
    await page.getByRole('switch', { name: '被动健康检查', exact: true }).click();
    await page.screenshot({
      path: '.local/screenshots/v3-route-upstream.png',
      fullPage: true,
      animations: 'disabled',
    });

    await page.getByRole('tab', { name: '请求处理' }).click();
    await page.getByRole('switch', { name: '配置请求改写', exact: true }).click();
    await choose(page, '路径改写方式', '正则改写');
    await page.getByLabel('请求改写匹配正则 1', { exact: true }).fill(`^/${id}/(.*)`);
    await page.getByLabel('请求改写替换路径 1', { exact: true }).fill('/__inspect/$1');
    await page.getByLabel('改写 Host', { exact: true }).fill('upstream.internal');
    await choose(page, '改写 HTTP 方法', 'POST');
    for (const [label, key, value] of [
      ['覆盖请求头', 'X-Console-Set', 'replaced'],
      ['追加请求头', 'X-Console-Add', 'added'],
    ]) {
      await page.getByRole('button', { name: `添加${label}`, exact: true }).click();
      await page.getByLabel(`${label}名称 1`).fill(key);
      await page.getByLabel(`${label}值 1`).fill(value);
    }
    await page.getByRole('button', { name: '添加移除请求头', exact: true }).click();
    await page.getByLabel('移除请求头', { exact: true }).fill('X-Console-Remove');
    await page.screenshot({
      path: '.local/screenshots/v3-route-traffic.png',
      fullPage: true,
      animations: 'disabled',
    });
    const candidate = await config(page);
    expect(candidate).toMatchObject({
      uris: [`/${id}/*`, `/${id}-alternate/*`],
      hosts: ['console.test', 'alternate.test'],
      remote_addrs: ['0.0.0.0/0', '::/0'],
      enable_websocket: true,
      priority: 25,
      labels: { team: 'platform' },
      vars: [
        ['arg_version', '==', 'v2'],
        ['OR', ['http_x_tenant', '==', 'platform'], ['cookie_team', '==', 'platform']],
      ],
      upstream: {
        retries: 0,
        retry_timeout: 0,
        nodes: [{ host: 'echo', port: 80, weight: 1, priority: 0 }],
      },
    });
    expect(candidate.uri).toBeUndefined();
    await page.getByRole('tab', { name: '检查与预览' }).click();
    const beforeDrafts = await client.request(`/drafts?cluster_id=${cluster.id}`);
    await page.getByRole('button', { name: '校验当前配置', exact: true }).first().click();
    await expect(page.getByText('目标网关配置校验通过', { exact: true })).toBeVisible();
    expect(await client.request(`/drafts?cluster_id=${cluster.id}`)).toEqual(beforeDrafts);
    expect((await client.gateway(`/routes/${id}`)).status).toBe(404);
    const d = await save(page);
    expect(d.after).toEqual(candidate);
    const change = await release(client, d);
    const url = `http://127.0.0.1:19080/${id}/orders/42?version=v2`;
    const headers = {
      Host: 'console.test',
      'X-Tenant': 'platform',
      'X-Console-Set': 'old',
      'X-Console-Remove': 'gone',
    };
    await expect.poll(async () => (await sandboxProxy(url, { headers })).status).toBe(200);
    const body = await (await sandboxProxy(url, { headers })).text();
    expect(body).toContain(
      'method=POST\nuri=/__inspect/orders/42\nargs=version=v2\nhost=upstream.internal\nset=replaced\nadd=added\nremove=\n',
    );
    expect(
      (await sandboxProxy(url, { headers: { Host: 'wrong.test', 'X-Tenant': 'platform' } })).status,
    ).toBe(404);
    expect((await sandboxProxy(url.replace('v2', 'v1'), { headers })).status).toBe(404);
    expect(
      (await sandboxProxy(url, { headers: { Host: 'console.test', 'X-Tenant': 'other' } })).status,
    ).toBe(404);
    await page.goto(`/routes/${id}/edit?cluster=${cluster.id}`);
    expect(await config(page)).toMatchObject(candidate);
    const rollback = await client.request(`/changesets/${change.id}/rollback`, 'POST', {});
    await client.request(`/changesets/${rollback.id}/publish`, 'POST', {});
    expect((await client.waitChange(rollback.id)).status).toBe('succeeded');
    expect((await client.gateway(`/routes/${id}`)).status).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('校验结果不会覆盖较新的编辑；无效健康状态码保留在输入框并阻止保存', async ({ page }) => {
  const { id, cleanup } = await setup(page, 'validation');
  try {
    await json(page, { uri: `/${id}`, upstream: { nodes: { 'echo:80': 1 } } });
    await page.getByText('可视化表单', { exact: true }).click();
    let releaseResponse!: () => void;
    let signalStarted!: () => void;
    const hold = new Promise<void>((resolve) => (releaseResponse = resolve));
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    await page.route('**/api/v1/clusters/*/validate', async (route) => {
      const response = await route.fetch();
      signalStarted();
      await hold;
      await route.fulfill({ response });
    });
    await page.getByRole('tab', { name: '检查与预览' }).click();
    await page.getByRole('button', { name: '校验当前配置', exact: true }).first().click();
    await started;
    await page.getByRole('tab', { name: '基础与匹配' }).click();
    await page.getByLabel('资源说明', { exact: true }).fill('校验期间更新');
    releaseResponse();
    await expect(page.getByText('配置已修改，请重新校验当前版本', { exact: true })).toBeVisible();
    await page.unroute('**/api/v1/clusters/*/validate');
    await page.getByRole('tab', { name: '检查与预览' }).click();
    await expect(page.getByText('目标网关 Schema 与插件配置校验通过', { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: '校验当前配置', exact: true }).first().click();
    await expect(
      page.getByText('目标网关 Schema 与插件配置校验通过', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '上游服务' }).click();
    await page.getByRole('switch', { name: '主动健康检查', exact: true }).click();
    const codes = page.getByLabel('主动健康状态码', { exact: true });
    await codes.fill('abc');
    await codes.press('Enter');
    await codes.press('Escape');
    await expect(
      page
        .getByRole('tabpanel', { name: '上游服务' })
        .getByText('状态码须为 100–599 的整数', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: '草稿差异预览' })).toHaveCount(0);
    expect((await config(page)).upstream.checks.active.healthy.http_statuses).toEqual([200, 302]);
    await page
      .locator('.ant-form-item')
      .filter({ has: codes })
      .getByRole('button', { name: '清除', exact: true })
      .click();
    await expect(page.getByText('状态码须为 100–599 的整数', { exact: true })).toHaveCount(0);
    await save(page);
  } finally {
    await cleanup();
  }
});

test('引用服务与共享插件可选择、草稿重开保留且只读模式不可修改', async ({ page }) => {
  const { client, cluster, id, cleanup } = await setup(page, 'references');
  const service = `${id}-service`,
    shared = `${id}-plugins`,
    empty = id + '-empty';
  const body = {
    name: cluster.name,
    environment: cluster.environment,
    url: cluster.url,
    description: cluster.description,
    read_only: false,
  };
  try {
    await client.gateway(`/services/${service}`, 'PUT', {
      name: '服务引用验收',
      upstream: { nodes: { 'echo:80': 1 } },
    });
    await client.gateway(`/plugin_configs/${shared}`, 'PUT', {
      desc: '共享插件验收',
      plugins: { cors: {}, 'request-id': {} },
    });
    await client.gateway('/plugin_configs/' + empty, 'PUT', { desc: '空配置验收', plugins: {} });
    await page.reload();
    await page.getByLabel('资源 ID', { exact: true }).fill(id);
    await page.getByLabel('匹配路径 URI', { exact: true }).fill(`/${id}`);
    await page.getByRole('tab', { name: '上游服务' }).click();
    await choose(page, '绑定服务', `服务引用验收 · ${service}`);
    await page.getByRole('tab', { name: '插件配置' }).click();
    const selector = page.getByLabel('引用插件配置', { exact: true });
    await selector.fill('request-id');
    const dropdown = page.locator('.ant-select-dropdown:visible');
    await expect(dropdown.getByText('空配置验收 · ' + empty, { exact: true })).toHaveCount(0);
    await dropdown.getByText('共享插件验收 · ' + shared, { exact: true }).click();
    const list = page.getByRole('list', { name: '共享配置中的插件' });
    await expect(list.getByText('继承共享配置', { exact: true })).toHaveCount(2);
    const [policies] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: '管理共享配置' }).click(),
    ]);
    await expect(policies.getByPlaceholder('搜索资源 ID 或名称')).toHaveValue(shared);
    await expect(policies.getByRole('row').filter({ hasText: shared })).toContainText('request-id');
    await policies.close();
    await choose(page, '引用插件配置', '空配置验收 · ' + empty);
    await expect(page.getByText('此配置未包含插件', { exact: true }).last()).toBeVisible();
    await page.locator('.shared-plugin-reference .ant-select').hover();
    await page.locator('.shared-plugin-reference .ant-select-clear').click();
    expect((await config(page)).plugin_config_id).toBeUndefined();
    await choose(page, '引用插件配置', `共享插件验收 · ${shared}`);
    await json(page, { ...(await config(page)), plugins: { cors: { _meta: { disable: true } } } });
    await page.getByText('可视化表单', { exact: true }).click();
    await page.getByRole('tab', { name: '插件配置' }).click();
    const overridden = list.getByRole('listitem').filter({ hasText: 'cors' });
    await expect(overridden).toContainText('路由覆盖');
    await expect(overridden).toContainText('已停用');
    await expect(list.getByRole('listitem').filter({ hasText: 'request-id' })).toContainText(
      '继承共享配置',
    );
    const d = await save(page);
    expect(d.after).toMatchObject({ service_id: service, plugin_config_id: shared });
    expect(Object.keys(d.after.plugins)).toEqual(['cors']);
    expect(d.after.upstream).toBeUndefined();
    await page.goto(`/drafts/${d.id}/edit?cluster=${cluster.id}`);
    await expect(page.getByLabel('资源 ID', { exact: true })).toHaveValue(id);
    expect((await config(page)).service_id).toBe(service);
    await page.getByRole('tab', { name: '插件配置' }).click();
    await expect(overridden).toContainText('已停用');
    await client.gateway('/plugin_configs/' + shared, 'PUT', {
      plugins: { cors: {}, 'request-id': {}, 'proxy-rewrite': { host: 'example.org' } },
    });
    await page.getByRole('button', { name: '刷新共享配置' }).click();
    await expect(list.getByText('proxy-rewrite')).toBeVisible();
    await client.gateway('/plugin_configs/' + shared, 'DELETE');
    await page.getByRole('button', { name: '刷新共享配置' }).click();
    await expect(page.getByText('当前集群中找不到引用的共享配置 ' + shared)).toBeVisible();
    expect((await config(page)).plugin_config_id).toBe(shared);
    await client.request(`/clusters/${cluster.id}`, 'PUT', { ...body, read_only: true });
    await page.reload();
    await expect(page.getByLabel('资源名称', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '保存草稿', exact: true }).first(),
    ).toBeDisabled();
    await page.getByRole('tab', { name: '上游服务' }).click();
    await expect(page.getByLabel('绑定服务', { exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: '插件配置' }).click();
    await expect(selector).toBeDisabled();
    await expect(page.getByRole('button', { name: '添加插件', exact: true })).toBeDisabled();
  } finally {
    await client.request(`/clusters/${cluster.id}`, 'PUT', body);
    await cleanup();
    await client.gateway(`/services/${service}`, 'DELETE');
    await client.gateway(`/plugin_configs/${shared}`, 'DELETE');
    await client.gateway('/plugin_configs/' + empty, 'DELETE');
  }
});

test('无效输入不会静默保存旧值；表单和 JSON 往返保留扩展字段', async ({ page }) => {
  const { id, cleanup } = await setup(page, 'buffers');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.getByLabel('匹配路径 URI', { exact: true }).fill(`/${id}`);
    await page.getByRole('button', { name: '添加匹配路径 URI', exact: true }).click();
    await page.getByLabel('匹配路径 URI 2', { exact: true }).fill(`/${id}`);
    await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
    await expect(page.getByText('匹配路径 URI不能重复', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: '请求处理' }).click();
    await page.getByRole('tab', { name: '基础与匹配' }).click();
    await expect(page.getByLabel('匹配路径 URI 2', { exact: true })).toHaveValue(`/${id}`);
    await page.getByRole('button', { name: '移除匹配路径 URI 2', exact: true }).click();
    const imported = {
      uri: `/${id}`,
      methods: ['GET'],
      priority: 0,
      status: 0,
      enable_websocket: false,
      labels: { team: 'platform' },
      future_extension: { nested: [false, 0, { x: 'keep' }] },
      plugins: { 'proxy-rewrite': { headers: { 'X-Legacy': 'keep' }, _meta: { priority: 0 } } },
      upstream: {
        type: 'roundrobin',
        nodes: [{ host: 'echo', port: 80, weight: 1, priority: 0 }],
        retries: 0,
      },
    };
    await json(page, imported);
    await page.getByText('可视化表单', { exact: true }).click();
    await page.getByLabel('资源说明', { exact: true }).fill('只修改说明');
    await page.getByRole('tab', { name: '请求处理' }).click();
    await page.getByRole('button', { name: '添加追加请求头', exact: true }).click();
    await page.getByLabel('追加请求头名称 1').fill('X-New');
    await page.getByLabel('追加请求头值 1').fill('value');
    const next = await config(page);
    expect(next.future_extension).toEqual(imported.future_extension);
    expect(next.plugins['proxy-rewrite']).toEqual({
      headers: { set: { 'X-Legacy': 'keep' }, add: { 'X-New': 'value' } },
      _meta: { priority: 0 },
    });
    expect(next.upstream).toEqual(imported.upstream);
    await json(page, { ...next, methods: 'GET', upstream: { nodes: [null] } });
    await page.getByText('可视化表单', { exact: true }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.getByText(/methods 字段类型错误/).first()).toBeVisible();
    await json(page, next);
    await page.getByText('可视化表单', { exact: true }).click();
    const d = await save(page);
    expect(d.after).toEqual(next);
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('重定向方式互斥切换、双向插件同步与响应式布局', async ({ page }) => {
  const { cleanup } = await setup(page, 'redirect');
  try {
    await page.getByLabel('匹配路径 URI', { exact: true }).fill('/redirect-ui/*');
    await page.getByRole('tab', { name: '请求处理' }).click();
    await page.getByRole('switch', { name: '配置重定向', exact: true }).click();
    await page.getByLabel('重定向目标', { exact: true }).fill('https://example.com/new');
    await page.getByRole('switch', { name: '追加原查询参数', exact: true }).click();
    await choose(page, '重定向方式', '正则匹配与替换');
    await page.getByLabel('重定向匹配正则 1', { exact: true }).fill('^/redirect-ui/(.*)');
    await page.getByLabel('重定向替换路径 1', { exact: true }).fill('https://example.com/$1');
    expect((await config(page)).plugins.redirect.uri).toBeUndefined();
    await choose(page, '重定向方式', 'HTTP 转 HTTPS');
    expect((await config(page)).plugins.redirect).toEqual({ ret_code: 302, http_to_https: true });
    await page.getByRole('tab', { name: '插件配置' }).click();
    await expect(
      page.getByRole('button', { name: '编辑插件 redirect', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '编辑插件 redirect', exact: true }).click();
    await choose(page, 'http_to_https', '停用 false');
    await page.getByRole('dialog').getByLabel('uri', { exact: true }).fill('/conflicting');
    // This intermediate plugin config is intentionally invalid and must not be applied.
    await page.getByRole('button', { name: '应用到路由草稿', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /取\s*消/, exact: true })
      .click();
    expect((await config(page)).plugins.redirect.http_to_https).toBe(true);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const tab of ['基础与匹配', '上游服务', '请求处理', '插件配置', '检查与预览']) {
        await page.getByRole('tab', { name: tab }).click();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${width}: ${tab}`,
        ).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '切换颜色主题' }).click();
    await page.getByRole('tab', { name: '请求处理' }).click();
    await page.screenshot({
      path: '.local/screenshots/v3-route-dark.png',
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await cleanup();
  }
});

test('动态插件表单编辑嵌套对象数组、布尔值和执行选项', async ({ page }) => {
  const { cleanup } = await setup(page, 'schema');
  try {
    await page.getByLabel('匹配路径 URI', { exact: true }).fill('/plugin-form');
    await page.getByRole('tab', { name: '插件配置' }).click();
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    await page.getByPlaceholder('搜索插件名称或用途').fill('response-rewrite');
    await page.locator('.plugin-picker button').filter({ hasText: 'response-rewrite' }).click();
    await page.getByRole('spinbutton', { name: 'status_code', exact: true }).fill('201');
    await page.getByRole('button', { name: 'filters', exact: true }).click();
    await page.getByRole('button', { name: '配置 filters', exact: true }).click();
    await page.getByRole('button', { name: '添加 filters 项', exact: true }).click();
    await page.getByLabel('filters[0].regex', { exact: true }).fill('old');
    await page.getByLabel('filters[0].replace', { exact: true }).fill('new');
    await page.getByRole('button', { name: '高级执行选项', exact: true }).click();
    await page.getByLabel('插件执行优先级', { exact: true }).fill('0');
    await page
      .getByLabel('插件执行条件 JSON', { exact: true })
      .fill('[ ["arg_version", "==", "v2"] ]');
    await page.screenshot({
      path: '.local/screenshots/v3-plugin-schema.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '应用到路由草稿', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const rewrite = (await config(page)).plugins['response-rewrite'];
    expect(rewrite).toMatchObject({
      status_code: 201,
      filters: [{ regex: 'old', replace: 'new' }],
      _meta: { priority: 0, filter: [['arg_version', '==', 'v2']] },
    });
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    await page.getByPlaceholder('搜索插件名称或用途').fill('request-id');
    await page.locator('.plugin-picker button').filter({ hasText: 'request-id' }).click();
    await choose(page, 'include_in_response', '停用 false');
    await page.getByRole('button', { name: '应用到路由草稿', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await config(page)).plugins['request-id'].include_in_response).toBe(false);
    await save(page);
  } finally {
    await cleanup();
  }
});

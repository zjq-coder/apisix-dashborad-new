import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import { sandboxClient, sandboxProxy } from '../../scripts/sandbox-client.mjs';
import type { Cluster, Draft, Change } from '../../web/src/types';

let client: Awaited<ReturnType<typeof sandboxClient>>, dev: Cluster;
const ids = new Set<string>();
const records = () => client.request('/drafts?cluster_id=' + dev.id) as Promise<Draft[]>;
const button = (p: Page, name: string) => p.getByRole('button', { name, exact: true });
const fresh = () => {
  const id = 'actions-' + randomBytes(5).toString('hex');
  ids.add(id);
  return id;
};
test.beforeAll(async () => {
  client = await sandboxClient();
  dev = (await client.request('/clusters')).find(
    (c: Cluster) => c.url === 'http://apisix:9180/apisix/admin' && c.environment === 'development',
  );
  expect(dev).toBeTruthy();
  expect(dev.read_only).toBeFalsy();
});
test.afterEach(async () => {
  for (const d of await records())
    if (ids.has(d.resource_id) && d.status === 'draft')
      await client.request('/drafts/' + d.id, 'DELETE');
  for (const id of ids) await client.gateway('/routes/' + id, 'DELETE');
  ids.clear();
});
async function open(p: Page) {
  const [name, value] = client.cookie.split('=');
  await p.context().addCookies([{ name, value, url: 'http://127.0.0.1:18080' }]);
  await routes(p);
}
async function routes(p: Page) {
  await p.goto('/routes?cluster=' + dev.id);
  await expect(button(p, '新建路由')).toBeVisible();
}
function row(p: Page, id: string) {
  return p.getByRole('row').filter({ has: button(p, id) });
}
async function fixture(id: string, status = 1) {
  const response = await client.gateway('/routes/' + id, 'PUT', {
    name: id,
    uri: '/' + id,
    methods: ['GET'],
    upstream_id: 'sandbox-orders',
    status,
    plugins: { 'request-id': { include_in_response: true } },
    labels: { suite: 'actions' },
  });
  expect(response.status).toBeLessThan(300);
}
async function more(p: Page, id: string, act: string) {
  if (act === '查看') {
    await button(p, '查看配置 ' + id).click();
    return;
  }
  await button(p, '更多操作 ' + id).click();
  await expect(p.getByRole('menuitem', { name: act, exact: true })).toBeVisible();
  await p.screenshot({ path: '.local/screenshots/route-actions-menu.png', animations: 'disabled' });
  await p.getByRole('menuitem', { name: act, exact: true }).click();
}
async function apply(p: Page, label: string, path = '/config/apply') {
  const response = p.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() === 'POST',
  );
  await button(p, label).first().click();
  const resp = await response;
  expect(resp.status()).toBe(201);
  const change: Change = await client.waitChange((await resp.json()).id);
  expect(change.status).toBe('succeeded');
  expect(change.operations?.every((op) => op.status === 'applied' && !op.draft_id)).toBe(true);
  return change.operations!;
}
const http = (path: string) => sandboxProxy(path).then((r: Response) => r.status);
test('行操作：网关查看、配置、复制、上下线和删除经发布后生效', async ({ page }) => {
  const id = fresh();
  await fixture(id);
  await open(page);
  const r = row(page, id);
  await expect.poll(() => http('/' + id)).toBe(200);
  await more(page, id, '查看');
  const view = page.getByRole('dialog', { name: '查看网关路由' });
  await expect(view.locator('pre')).toContainText('request-id');
  expect(JSON.parse(await view.locator('pre').innerText()).status).toBe(1);
  await page.keyboard.press('Escape');
  await r.getByRole('button', { name: '配置', exact: true }).click();
  await expect(page.getByLabel('资源名称')).toHaveValue(id);
  await routes(page);
  await more(page, id, '复制');
  await expect(page.getByLabel('资源名称')).toHaveValue(id + '-copy');
  const copy = fresh();
  await page.getByLabel('资源 ID', { exact: true }).fill(copy);
  const [copyDraft] = await apply(page, '保存并发布');
  expect(copyDraft.after).toMatchObject({
    name: id + '-copy',
    upstream_id: 'sandbox-orders',
    labels: { suite: 'actions' },
  });
  expect(copyDraft.resource_id).toBe(copy);
  expect((await client.gateway('/routes/' + copy)).status).toBe(200);
  await client.gateway('/routes/' + copy, 'DELETE');
  await routes(page);
  await r.getByRole('button', { name: '下线', exact: true }).click();
  await button(page, '取消').click();
  expect((await records()).filter((d) => d.resource_id === id)).toHaveLength(0);
  for (const [label, before, after] of [
    ['下线', 200, 404],
    ['发布', 404, 200],
  ] as const) {
    await r.getByRole('button', { name: label, exact: true }).click();
    expect(await http('/' + id)).toBe(before);
    const [operation] = await apply(page, '确认' + label);
    expect(operation.diff.map((d) => d.path)).toEqual(['/status']);
    await expect.poll(() => http('/' + id)).toBe(after);
    await routes(page);
  }
  await more(page, id, '删除');
  const [deletion] = await apply(page, '确认删除');
  expect(deletion.action).toBe('delete');
  expect((await records()).some((d) => ids.has(d.resource_id))).toBe(false);
  await expect.poll(() => http('/' + id)).toBe(404);
});

test('高级工具、跨格式导出及导入预览、批量发布', async ({ page }) => {
  const id = fresh();
  await fixture(id);
  await open(page);
  await expect(button(page, '导出 OpenAPI')).toBeDisabled();
  await button(page, '高级特性').click();
  await page.getByRole('menuitem', { name: '插件模板配置' }).click();
  await expect(page).toHaveURL(/policies.*kind=plugin_configs/);
  await routes(page);
  await button(page, '高级特性').click();
  await page.getByRole('menuitem', { name: '数据编辑器' }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await expect(page.getByLabel('资源 ID', { exact: true })).toBeEditable();
  const rawId = fresh();
  await page.getByLabel('资源 ID', { exact: true }).fill(rawId);
  const updateJson = async (value: object) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      JSON.stringify(value, null, 2),
    );
    await page.locator('.monaco-editor textarea').first().focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
  };
  const rawRoute = {
    id: rawId,
    name: rawId,
    uri: '/' + rawId,
    upstream_id: 'sandbox-orders',
    status: 0,
  };
  await updateJson({ ...rawRoute, id: 'wrong-id' });
  await button(page, '保存并发布').first().click();
  await expect(page.getByText('JSON 中的 id 必须与资源 ID 一致').first()).toBeVisible();
  await updateJson(rawRoute);
  await expect(page.locator('.editor-aside .config-preview')).toContainText(rawId);
  const [rawDraft] = await apply(page, '保存并发布');
  expect(rawDraft.resource_id).toBe(rawId);
  expect(rawDraft.after).toMatchObject({ upstream_id: 'sandbox-orders', status: 0 });
  expect((await client.gateway('/routes/' + rawId)).status).toBe(200);
  await routes(page);
  await page.getByRole('checkbox', { name: '选择路由 ' + id, exact: true }).check();
  let yaml = '';
  for (const fmt of ['JSON', 'YAML']) {
    await button(page, '导出 OpenAPI (1)').click();
    await page.getByRole('radio', { name: fmt }).check();
    const file = page.waitForEvent('download');
    await button(page, '下载').click();
    const dl = await file;
    expect(dl.suggestedFilename()).toBe('apisix-routes.' + fmt.toLowerCase());
    const raw = await readFile((await dl.path())!, 'utf8');
    const doc = parse(raw);
    expect(Object.keys(doc.paths)).toEqual(['/' + id]);
    expect(doc['x-apisix-routes'][0].id).toBe(id);
    if (fmt === 'YAML') yaml = raw;
  }
  await button(page, '高级特性').click();
  await page.getByRole('menuitem', { name: '导入 OpenAPI' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'routes.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(yaml),
  });
  await button(page, '解析路由').click();
  await button(page, '预览目标差异').click();
  await expect(page.getByRole('cell', { name: '相同', exact: true })).toBeVisible();
  await expect(button(page, '批量发布')).toBeDisabled();
  const imported = fresh(),
    doc = {
      openapi: '3.0.3',
      info: { title: 'Orders', version: '1' },
      paths: { ['/' + imported + '/{id}']: { get: { operationId: imported } } },
    };
  await page.getByRole('textbox', { name: 'OpenAPI 文档' }).fill(JSON.stringify(doc));
  await button(page, '解析路由').click();
  await expect(page.getByText('请为标准 OpenAPI 操作选择上游')).toBeVisible();
  await page.getByLabel('默认上游').click();
  await page.getByTitle('orders-service · sandbox-orders', { exact: true }).click();
  await button(page, '解析路由').click();
  await button(page, '预览目标差异').click();
  await expect(button(page, '批量发布')).toBeEnabled();
  await page.screenshot({
    path: '.local/screenshots/route-actions-openapi-preview.png',
    fullPage: true,
    animations: 'disabled',
  });
  const [importOp] = await apply(page, '批量发布', '/transfer/apply');
  expect(importOp.after).toMatchObject({ status: 0, upstream_id: 'sandbox-orders' });
  expect((await client.gateway('/routes/' + imported)).status).toBe(200);
  expect(await http('/' + imported + '/42')).toBe(404);
  await routes(page);
  await row(page, imported).getByRole('button', { name: '发布', exact: true }).click();
  await apply(page, '确认发布');
  await expect.poll(() => http('/' + imported + '/42')).toBe(200);
  expect(await http('/' + imported + '/42/extra')).toBe(404);
});

test('批量删除对基线变化、重复 ID 及已有草稿整批回滚，正常操作可发布', async ({ page }) => {
  const a = fresh(),
    b = fresh();
  await fixture(a);
  await fixture(b);
  await open(page);
  const resources = await client.request('/clusters/' + dev.id + '/resources/routes');
  const refs = [a, b].map((id) => ({
    id,
    base_hash: resources.items.find((r: { id: string }) => r.id === id).hash,
  }));
  const endpoint = '/clusters/' + dev.id + '/routes/batch-delete/apply';
  for (const [entries, status] of [
    [[], 400],
    [[refs[0], refs[0]], 400],
    [[refs[0], { ...refs[1], base_hash: 'stale' }], 409],
  ] as const) {
    await expect(client.request(endpoint, 'POST', { routes: entries })).rejects.toMatchObject({
      status,
    });
  }
  const pending = await client.request('/drafts', 'POST', {
    cluster_id: dev.id,
    resource_type: 'routes',
    resource_id: b,
    action: 'delete',
    title: b,
    base_hash: refs[1].base_hash,
  });
  await expect(client.request(endpoint, 'POST', { routes: refs })).rejects.toMatchObject({
    status: 409,
  });
  expect((await records()).some((d) => d.status === 'draft' && d.resource_id === a)).toBe(false);
  await client.request('/drafts/' + pending.id, 'DELETE');
  for (const id of [a, b])
    await page.getByRole('checkbox', { name: '选择路由 ' + id, exact: true }).check();
  await button(page, '批量删除').click();
  await button(page, '取消').click();
  expect(await http('/' + a)).toBe(200);
  await button(page, '批量删除').click();
  const ds = await apply(page, '确认删除', '/routes/batch-delete/apply');
  expect(ds.map((d) => d.resource_id).sort()).toEqual([a, b].sort());
  await expect.poll(() => http('/' + a)).toBe(404);
  await expect.poll(() => http('/' + b)).toBe(404);
});

test('只读成员能查看和导出，英文和窄屏可操作，服务端拒绝批量删除', async ({ page }) => {
  const id = fresh();
  await fixture(id);
  const name = 'actions-reader-' + randomBytes(4).toString('hex'),
    password = randomBytes(16).toString('hex');
  const account = await client.request('/users', 'POST', {
    username: name,
    password,
    role: 'member',
    enabled: true,
    grants: { [dev.id]: [] },
  });
  try {
    await page.goto('/routes?cluster=' + dev.id);
    await page.getByLabel('用户名', { exact: true }).fill(name);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await button(page, '登录控制台').click();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await routes(page);
    const r = row(page, id);
    await expect(r.getByRole('button', { name: '下线', exact: true })).toBeDisabled();
    await expect(r.getByRole('button', { name: '配置', exact: true })).toBeDisabled();
    await button(page, '更多操作 ' + id).click();
    await expect(page.getByRole('menuitem', { name: '复制', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');
    await button(page, '查看配置 ' + id).click();
    await expect(page.getByRole('dialog').locator('pre')).toContainText(id);
    await page.keyboard.press('Escape');
    await page.getByRole('checkbox', { name: '选择路由 ' + id, exact: true }).check();
    await expect(button(page, '批量删除')).toBeDisabled();
    await expect(button(page, '导出 OpenAPI (1)')).toBeEnabled();
    const session = await (await page.request.get('/api/v1/session')).json();
    const resp = await page.request.post(
      '/api/v1/clusters/' + dev.id + '/routes/batch-delete/apply',
      {
        headers: { 'X-CSRF-Token': session.csrf_token },
        data: { routes: [] },
      },
    );
    expect(resp.status()).toBe(403);
    await button(page, '切换语言').first().click();
    await page.getByText('English', { exact: true }).last().click();
    await page.setViewportSize({ width: 390, height: 844 });
    const fits = await page.locator('.route-row-actions').evaluateAll((groups) =>
      groups.every((group) => {
        const cell = group.closest('td')!.getBoundingClientRect();
        return [...group.querySelectorAll('button')].every(
          (button) => button.getBoundingClientRect().right <= cell.right + 1,
        );
      }),
    );
    expect(fits).toBe(true);
    await expect(button(page, 'Advanced tools')).toBeVisible();
    await button(page, 'Advanced tools').click();
    await expect(page.getByRole('menuitem', { name: 'Import OpenAPI' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  } finally {
    await client.request('/users/' + name, 'DELETE', { revision: account.revision });
  }
});

test('已打开的行状态确认遇到并发修改时拒绝，网关详情与导出隐藏凭据', async ({ page }) => {
  const id = fresh(),
    secret = 'fixture-' + randomBytes(16).toString('hex');
  const value = {
    name: id,
    uri: '/' + id,
    upstream_id: 'sandbox-orders',
    plugins: { 'proxy-rewrite': { headers: { set: { Authorization: secret } } } },
  };
  expect((await client.gateway('/routes/' + id, 'PUT', value)).status).toBeLessThan(300);
  await open(page);
  await more(page, id, '查看');
  await expect(page.getByRole('dialog').locator('pre')).toContainText('keep-secret');
  await expect(page.getByRole('dialog')).not.toContainText(secret);
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: '选择路由 ' + id, exact: true }).check();
  await button(page, '导出 OpenAPI (1)').click();
  const pending = page.waitForEvent('download');
  await button(page, '下载').click();
  const raw = await readFile((await (await pending).path())!, 'utf8');
  expect(raw).not.toContain(secret);
  expect(raw).toContain('keep-secret');
  await row(page, id).getByRole('button', { name: '下线', exact: true }).click();
  expect(
    (await client.gateway('/routes/' + id, 'PUT', { ...value, desc: 'updated outside dashboard' }))
      .status,
  ).toBeLessThan(300);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/config/apply') && r.request().method() === 'POST',
  );
  await button(page, '确认下线').click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('dialog')).toContainText('网关配置已变化');
  expect(
    (await records()).filter((d) => d.resource_id === id && d.status === 'draft'),
  ).toHaveLength(0);
  await button(page, '取消').click();
  await routes(page);
  await row(page, id).getByRole('button', { name: '下线', exact: true }).click();
  const [draft] = await apply(page, '确认下线');
  expect(draft.diff.map((d) => d.path)).toEqual(['/status']);
  expect(
    (await client.gateway('/routes/' + id)).data.value.plugins['proxy-rewrite'].headers.set
      .Authorization === secret,
  ).toBe(true);
});

test('切换集群会清空所选路由；只读连接也限制管理员写入', async ({ page }) => {
  const id = fresh();
  await fixture(id);
  await open(page);
  await page.getByRole('checkbox', { name: '选择路由 ' + id, exact: true }).check();
  const stage = (await client.request('/clusters')).find(
    (c: Cluster) => c.url === 'http://apisix-staging:9180/apisix/admin',
  );
  expect(stage).toBeTruthy();
  await page.getByRole('combobox', { name: '当前集群' }).click();
  await page.locator('.ant-select-dropdown:visible').getByText(stage.name, { exact: true }).click();
  await expect(row(page, 'staging-env-check')).toBeVisible();
  await expect(button(page, '导出 OpenAPI')).toBeDisabled();
  const setMode = async (read_only: boolean) => {
    const current: Cluster = (await client.request('/clusters')).find(
      (c: Cluster) => c.id === dev.id,
    );
    return client.request('/clusters/' + dev.id, 'PUT', {
      name: current.name,
      url: current.url,
      environment: current.environment,
      description: current.description,
      read_only,
    });
  };
  try {
    await setMode(true);
    await routes(page);
    const r = row(page, id);
    await expect(r.getByRole('button', { name: '下线', exact: true })).toBeDisabled();
    await button(page, '高级特性').click();
    await expect(page.getByRole('menuitem', { name: '数据编辑器' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    const entry = await client.request('/clusters/' + dev.id + '/resources/routes/' + id);
    await expect(
      client.request('/clusters/' + dev.id + '/routes/batch-delete/apply', 'POST', {
        routes: [{ id, base_hash: entry.hash }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await http('/' + id)).toBe(200);
  } finally {
    await setMode(dev.read_only);
  }
});

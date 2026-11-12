import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [routeFile, nodeFile, authFile] = process.argv.slice(2);
assert.ok(
  routeFile && nodeFile && authFile,
  'Pass full route, isolated gateway and consumer JSON reports',
);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const [routes, node, consumers, groups] = await Promise.all(
  [routeFile, nodeFile, authFile, 'web/src/data/plugin-hub.json'].map(read),
);
assert.ok(routes.cleanup && node.cleanup && consumers.passed && !consumers.cleanupErrors.length);
assert.ok(Object.values(routes.rows).every((r) => r.result !== 'failed'));
assert.ok(Object.values(node.rows).every((r) => r.result !== 'failed'));
const official = new Set(groups.flatMap((g) => Object.keys(g.plugins)));
const names = (name) =>
  name === 'serverless' ? ['serverless-pre-function', 'serverless-post-function'] : [name];
const extensions = Object.keys(routes.rows)
  .filter((name) => !routes.rows[name].official)
  .sort();
const verified = (name) =>
  [node.rows[name], routes.rows[name]].some((r) => r?.result === 'effect-verified');
const count = [...official].filter((name) => names(name).every(verified)).length;
const lines = [
  '# APISIX 插件配置与验证',
  '',
  '本次使用本地 APISIX 3.19.0。按官网目录逐项核对 ' +
    official.size +
    ' 个条目，其中 ' +
    count +
    ' 个条目观察到了下表所列的运行时效果。官网的 `serverless` 对应两个独立执行插件。另有 ' +
    extensions.length +
    ' 个当前集群扩展，其中 ' +
    extensions.filter(verified).length +
    ' 个观察到了实际效果。[Apache APISIX 插件目录](https://apisix.apache.org/zh/plugins/)',
  '',
  '## 配置操作',
  '',
  '在「路由管理 → 配置 → 插件配置 → 添加插件」中可按类别筛选和搜索。打开插件后可以查找字段、展开官方说明、配置必填值和可选项。数值与网关变量可显式切换类型，复杂分支也可在 JSON 模式编辑。路由上的认证策略与消费者上的凭据分开配置。切换语言会同时切换字段帮助、官方示例和文档链接。',
  '',
  '官网目录以外，部分集群插件也有 APISIX 版本文档。例如 `ldap-auth-advanced` 归在「集群扩展」，仍可查看官方说明与示例。字段帮助随控制台部署；维护者可运行 `python scripts/sync-plugin-guide.py --refresh` 更新文档。',
  '',
  '![路由插件编辑器与限流字段](screenshots/plugin-configuration.png)',
  '',
  '## 测试环境与判定',
  '',
  '- 开发网关的源路由为 `sandbox-orders-api`，路径为 `/api/orders/*`。测试使用唯一主机或 URI 创建临时路由，普通 HTTP 场景复用订单上游。每项常规路由用例均经 Dashboard 校验正确和错误配置、发布并从 Admin API 回读。仅验证 Schema 的步骤不计入运行时效果。',
  '- 需要模型、身份服务、遥测、云函数、WAF、gRPC 或 Dubbo 的插件使用本地协议测试端。接收请求、回调、返回数据或协议帧均按用例断言。云厂商真实账号的鉴权、存储、计费和生产质量未在本次范围内验证。浏览器认证跳转的覆盖深度按下表逐项列出。',
  '- Kafka、Redis、OpenLDAP 与 Go Plugin Runner 实际运行于本地容器。节点级、Stream、SSL 和插件元数据用例使用独立的网关与 etcd，避免覆盖现有集群设置。测试后检查临时资源清理结果，以及源订单路由配置哈希。',
  '- 状态码列为开发网关脚本记录的响应顺序。WebSocket、TLS、TCP、UDP、异步投递及独立网关断言以“实际观察”列为准。每一行的结论限于列出的行为，同一插件的每种提供商、选项组合和部署环境均需按实际配置验收。',
  '',
];
const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
function group(title, list) {
  lines.push(
    '## ' + title,
    '',
    '| 插件 | 运行环境 | HTTP | 实际观察 |',
    '| --- | --- | --- | --- |',
  );
  for (const item of list)
    for (const name of names(item)) {
      const r = routes.rows[name],
        n = node.rows[name];
      assert.ok(r, 'Missing route coverage: ' + name);
      assert.ok(verified(name) || n?.result === 'requires-dependency', 'Untested plugin: ' + name);
      const text = [r.result === 'effect-verified' && r.effect, n?.effect, n?.limitation]
        .filter(Boolean)
        .join('。');
      const where = [
        r.result === 'effect-verified' && '开发网关',
        n?.effect && '独立网关',
        n?.result === 'requires-dependency' && '本轮跳过（缺少依赖）',
      ]
        .filter(Boolean)
        .join('、');
      lines.push(
        '| `' +
          name +
          '` | ' +
          where +
          ' | ' +
          (r.statuses?.join(' → ') || '—') +
          ' | ' +
          cell(text) +
          ' |',
      );
    }
  lines.push('');
}
for (const g of groups) group(g.name, Object.keys(g.plugins));
group('集群扩展', extensions);
lines.push(
  '## 复测',
  '',
  '需要 Docker、Node.js 24+、本地演示环境和种子订单路由。OCSP 用例使用 Python 的 cryptography，文档同步使用 beautifulsoup4。首次运行会拉取测试镜像和官方 Go Runner v0.5.0。',
  '',
  '~~~sh',
  'npm run test:plugin-routes',
  'npm run test:plugin-nodes',
  'npm run test:consumer-plugins',
  'npx playwright test tests/e2e/plugin-configuration.spec.ts tests/e2e/plugin-hub.spec.ts tests/e2e/consumer-plugins.spec.ts',
  '~~~',
  '',
  '路由和节点脚本接受插件名称以单项复测，例如 `npm run test:plugin-routes -- limit-count proxy-cache`。完整运行结束后，用输出中的实际文件名生成本报告。',
  '',
  '~~~sh',
  'node scripts/report-plugin-verification.mjs .local/plugins-audit/<route-run>.json .local/plugins-audit/<node-run>/report.json .local/consumer-plugins-integration.json',
  '~~~',
  '',
  '本次路由网关启用 ' +
    routes.enabled +
    ' 个插件，实测发布并回读 ' +
    Object.values(routes.rows).filter((r) => r.published).length +
    ' 份路由插件配置。',
  '',
  '本次路由记录 `' +
    routes.run +
    '`，节点记录 `' +
    node.run +
    '`，消费者专项通过 ' +
    consumers.checks.length +
    ' 项检查。国密握手需要链接 Tongsuo 的网关和签名、加密双证书。[APISIX 国密配置说明](https://apisix.apache.org/zh/docs/apisix/plugins/gm/)',
  '',
);
await writeFile('docs/plugin-verification.md', lines.join('\n'));

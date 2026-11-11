# 消费者 API Key 配置与验收

日期：2026-11-10。验证环境：本地 Docker APISIX 3.19.0、PostgreSQL 16、控制台 `127.0.0.1:18080`、代理 `127.0.0.1:19080`。

此文记录首次 API Key 配置功能的验收。当前消费者界面已升级为通用插件配置，入口与最新测试结果见 [通用消费者认证插件实现与验收](consumer-plugin-verification.md)。

## 配置入口

路由上的 `key-auth.header` / `query` 指定密钥来自哪个请求头或查询参数；有效密钥配置在消费者的 `plugins.key-auth.key`。此前缺少消费者配置界面，本次已补齐。

1. 左侧「消费者管理」→ 新建或编辑消费者。
2. 「API Key 凭据」→「有效密钥（API Key）」中输入值，或点击「生成随机密钥」，先复制密钥。
3. 保存草稿 → 核对脱敏差异 → 创建发布变更 → 校验并发布。
4. 在目标路由启用 `key-auth`，请求头/参数名称可使用默认值 `apikey`。插件编辑框提供「管理消费者与密钥」入口，在新标签页打开以保留当前路由编辑。

已保存密钥不会回显；输入框留空保留原值。填写新密钥并发布才会轮换。删除消费者或移除 API Key 凭据也需要发布。消费者密钥在集群内用于认证，如需限制指定消费者访问路由，应配置 `consumer-restriction`。

## 实现与验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript / Vite 构建 | 通过，本地标准 Docker 镜像已更新并运行 |
| Vitest | 41 项通过 |
| Go | 28 个测试函数通过 `go test -race -count=1 ./...`，`go vet ./...` 通过 |
| 消费者真实集成 | 10 组通过，报告 `.local/consumer-integration.json` |
| 既有核心集成 | 14 组通过 |
| 高级路由集成 | 14 组通过 |
| Playwright | 13 项通过，含 3 项新增消费者场景 |
| Prettier | 通过 |

消费者集成覆盖用户名与资源标识一致性、消费者专属 Schema、空密钥与重复密钥、草稿未发布不影响网关、列表/详情/草稿/发布记录脱敏、保留原密钥、轮换、轮换回退、并发冲突、删除及删除回退。消费者写入复用现有只读保护和加密草稿存储；Admin API 写入前按 username 校验目标，避免写入其他消费者。

浏览器实测完成「生成密钥 → 复制 → 保存 → 发布 → 修改说明保留密钥 → 再次编辑轮换 → 发布 → 回退」，并检查真实代理响应。额外检查了插件入口的新标签页行为、深浅主题与 390px 窄屏无页面横向溢出。新增消费者只读界面场景通过浏览器拦截模拟只读标记；后端通用只读禁止保存/发布由既有真实集成场景覆盖。

浏览器测试发现发布成功后立即重开编辑页仍可能使用旧详情缓存，现已在发布完成时清除受影响资源的非活动详情缓存；连续编辑、密钥轮换及回退的浏览器回归已通过。

## health-check 最终状态

- 路由：`sandbox-health`，名称 `health-check`，路径 `/health`。
- 插件：`key-auth`，`header=apikey`、`query=apikey`、`hide_credentials=true`，未配置匿名消费者。
- 无密钥：HTTP 401；错误密钥：HTTP 401；此前提供的保留测试密钥：HTTP 200。
- 原测试消费者 `health-check-client-1794317787239` 保留，可在消费者管理中编辑；本次新增临时消费者和路由均已清理，相关验收发布历史保留。
- 最终本地配置：4 条路由、1 个消费者，集群可写。证据：`.local/consumer-final-check.json`（不包含密钥值）。

## 复跑

在项目根目录，按顺序运行（不要并行执行修改网关的套件）：

```powershell
npm run test:consumers
npm run test:integration
npm run test:routes
npx playwright test
```

HTML 浏览器报告：`playwright-report/index.html`。界面截图：`.local/screenshots/key-auth-guidance.png`、`consumer-key-editor.png`、`consumers-light.png`、`consumers-dark.png`、`consumer-mobile.png`。

消费者新增功能本次实测范围为 APISIX 3.19.0；未将此前路由的 3.14.1 验收视为消费者功能的版本证明。目前可视化管理内嵌 key-auth 凭据，独立多 Credential 和消费者组管理尚未实现；其他已有插件保留并可通过 JSON 编辑，最终以目标网关校验和实际写入结果为准。

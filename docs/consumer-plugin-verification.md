# 通用消费者认证插件实现与验收

日期：2026-11-10。目标为本地 APISIX 3.19.0 + etcd，Dashboard 通过 Admin API 管理。用户确认测试范围为所有消费者关联插件。本次以目标网关的实时插件元数据为准，发现 7 个独立消费者 Schema，加上使用共享 Schema 的 `wolf-rbac`，共 8 种消费者认证插件；另外验证组合认证与 3 个消费者关联策略。

## 使用方式与界面

1. 打开「消费者管理」，新建或编辑消费者，点击「添加插件」。
2. 在「认证凭据」中选择认证方式；「消费者策略」提供目标网关支持的其他策略插件，例如限流。同一消费者可以添加多种认证。
3. 填写对应 Schema 表单，或切换 JSON 编辑。应用时校验对应的消费者 Schema，再保存草稿、审查差异并发布。
4. 在路由「插件配置」中启用对应认证插件。弹窗提供消费者要求、调用格式和关联管理入口；链接在新标签页打开，保留当前路由编辑。
5. 密钥和密码支持安全随机生成及复制。已有值显示脱敏占位，留空保留；输入新值并发布完成轮换，移除认证插件并发布可撤销该凭据。

| 插件 | 消费者配置 | 路由配置要点 |
| --- | --- | --- |
| key-auth | key | header/query 是读取位置的名称，如 apikey |
| basic-auth | username、password | 启用 Basic；hide_credentials 控制转发时移除认证头 |
| jwt-auth | key、algorithm；HS 使用 secret，非对称算法使用 public_key | Token 读取位置、key_claim_name 等；切换算法动态显示公钥字段 |
| hmac-auth | 当前版本为 key_id、secret_key | 允许算法、签名请求头、时钟偏差；不同版本字段以目标 Schema 为准 |
| jwe-decrypt | key、secret、is_base64_encoded | header、forward_header、strict；密钥解码后必须为 32 字节 |
| ldap-auth | user_dn | LDAP 地址、base_dn、uid 与 TLS；用户密码在目录中管理 |
| ldap-auth-advanced | user_dn | LDAP 搜索、绑定账号、header_type、consumer_required 等 |
| wolf-rbac | appid、server、header_prefix、ssl_verify | 使用对应 appid 的 Wolf Token；消费者和路由共用 Schema |

消费者列表展示认证数量和所有已配置插件；路由入口可按认证插件筛选消费者。必填字段优先显示，敏感输入采用密码框。支持浅色/深色主题与窄屏单列布局。

## 实现要点

- 新增 `GET /clusters/{id}/plugins/catalog`：读取目标网关完整元数据，并与已启用插件求交集。前端不再将消费者字段固定为 key-auth。
- 插件 Schema 接口新增 `scope=route|consumer`，插件校验新增 `resource_type`。消费者使用独立 Schema；共享 Schema 仅在目标明确不支持消费者 Schema 时回退，权限或服务错误不会被隐藏。
- 复用 `PluginManager` 与递归 `SchemaFields`，消费者凭据不展示无效的执行启停开关。JWT 的 dependencies 分支增加公钥字段，但不缩窄算法选择器；复杂字段继续提供 JSON 编辑。
- 消费者基本信息、标签、多插件配置、草稿、差异、发布和回退均沿用现有闭环。独立 Credential 子资源与消费者组 CRUD 不在此次范围内。
- 服务端补充 JWT/JWE 的必要凭据约束与身份标识重复检查。所有真实写入仍交给目标 APISIX 最终校验。
- 脱敏采用原有字段规则加 Schema 声明；敏感路径随快照加密存储，列表、详情、草稿、发布与回退一致处理。校验恢复凭据时绑定集群、资源类型与资源 ID。
- Schema 缓存仅限一次网关对象的生命周期，避免列表内重复获取相同 Schema；不同集群和消费者/路由上下文使用不同缓存键。
- 差异计算明确区分「未配置插件」与「插件配置为空对象 `{}`」。新增和移除空配置认证插件会生成真实差异，可以正常保存、发布和回退。

## 真实请求结果

全部请求经过本地 APISIX 数据面 `127.0.0.1:19080`，配置通过 Dashboard 草稿和发布流程写入。临时路由转发至隔离的 HTTP 回显上游，核验实际转发头和身份，而不只检查 Admin API 保存成功。

| 认证插件 | 缺失凭据 | 错误凭据 | 正确凭据 | 额外验证 |
| --- | ---: | ---: | ---: | --- |
| key-auth | 401 | 401 | 200 | 密钥轮换、凭据隐藏 |
| basic-auth | 401 | 401 | 200 | 用户名/密码、空密码拒绝、密码轮换、Authorization 移除 |
| jwt-auth | 401 | 401 | 200 | HS256、RS256 公钥验签、过期 Token 拒绝、Base64 签名密钥、轮换 |
| hmac-auth | 401 | 401 | 200 | HMAC-SHA256、签名错误、时钟过期、密钥轮换 |
| jwe-decrypt | 403 | 400 | 200 | dir/A256GCM、解密后转发头、错误密钥长度、Base64URL 密钥、轮换 |
| ldap-auth | 401 | 401 | 200 | 真实 OpenLDAP 绑定、错误密码、消费者 DN 映射 |
| ldap-auth-advanced | 401 | 401 | 200 | 真实目录搜索与绑定；consumer_required=true 拒绝未映射用户，false 允许 |
| wolf-rbac | 401 | 403 | 200 | 应用标识解析、权限检查 HTTP 协议、返回身份头；使用协议测试服务 |

每一种认证都验证了：Schema 校验、草稿不提前写网关、敏感值脱敏、修改说明保留凭据、跨资源草稿上下文拒绝、移除凭据后拒绝访问，以及回退恢复。5 种本地密钥/密码认证还逐项验证了轮换后旧凭据失效与回退恢复。

| 关联插件 | 验证行为 |
| --- | --- |
| multi-auth | 同一消费者同时具备 API Key 与 Basic：两种方式均 200，无效认证 401；移除 API Key 后 Basic 和消费者限流配置仍保留 |
| consumer-restriction | 无认证 401；白名单消费者 200；另一个已认证消费者 403 |
| acl | 读取消费者 labels；允许标签 200，拒绝标签 403，无认证 401 |
| attach-consumer-label | 从消费者标签填充上游请求头；覆盖客户端伪造值，缺失标签时移除伪造头 |

## 自动化与证据

新增矩阵脚本 `scripts/test-consumer-plugins.mjs`，目前 55 组检查通过，结果写入 `.local/consumer-plugins-integration.json`。其发现的认证插件集合必须与逐项流量夹具集合一致，避免新增插件被静默漏测。

浏览器用例 `tests/e2e/consumer-plugins.spec.ts` 对 8 种认证分别执行：消费者 Schema 表单填写 → 校验 → 保存草稿与发布 → 路由插件表单与提示 → 发布 → 缺失/错误/有效认证请求 → 再次打开消费者检查脱敏。另有原 API Key 创建、复制、保留、轮换、回退、只读与主题布局回归。

前端单元测试 44 项通过，Go 后端 35 个顶层测试函数（含子用例）通过 race 检查与 vet。构建包含 TypeScript 检查，最终全量 Playwright 回归 21 项通过。

复跑顺序（在项目根目录，串行执行）：

```powershell
docker pull osixia/openldap:1.5.0
docker pull node:24-bookworm-slim
npm run test:web
npm run test:consumer-plugins
npm run test:consumers
npm run test:routes
npm run test:integration
npm run test:e2e
```

夹具创建唯一前缀的容器、消费者与路由，结束时清理，只保留脱敏报告和发布审计记录。LDAP 服务不映射宿主机端口，Wolf/回显服务仅在本地 Docker 网络使用。原有 health-check 认证配置独立保留。

## 验证边界

本轮真实网关为 APISIX 3.19.0，没有将结果扩展为所有 3.x 版本兼容保证。LDAP 测试使用真实 OpenLDAP 2.4.57 的隔离非 TLS 连接，没有覆盖生产目录的 TLS/AD/复杂搜索策略。Wolf 的网关插件运行真实，但外部权限服务是可控协议夹具，未验证真实 Wolf 平台的登录、发 Token、权限维护等流程。未将 JWT 的全部签名算法、所有 HMAC 算法或外部密钥库引用逐一实测。

依据目标实例 Schema 与插件源码实现；相关原始资料：[APISIX Basic 认证](https://apisix.apache.org/docs/apisix/plugins/basic-auth/)、[APISIX API Key 认证](https://apisix.apache.org/docs/apisix/plugins/key-auth/)、[OpenLDAP 测试镜像 1.5.0 使用说明](https://github.com/osixia/docker-openldap/blob/v1.5.0/README.md)。

## 最终回归与现有路由复核

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| TypeScript / Vite / Docker 构建 | 通过，已更新本地 18080 服务 | 标准 compose 构建与运行 |
| Vitest | 44 项通过 | `npm run test:web` |
| Go race / vet | 35 个顶层测试函数及子用例通过 | `go test -race -count=1 ./...`、`go vet ./...` |
| 全部消费者关联认证与策略 | 55 组通过 | `.local/consumer-plugins-integration.json` |
| 既有消费者闭环 | 10 组通过 | `.local/consumer-integration.json` |
| 高级路由与真实转发 | 14 组通过 | `.local/route-editor-integration.json` |
| 核心发布、冲突、引用、只读与审计 | 14 组通过 | `scripts/test-integration.mjs` 最终运行结果 |
| Playwright 全量 | 21 项通过，0 失败 | `playwright-report/index.html`、`test-results/.last-run.json` |
| 临时资源与服务 | 本轮消费者、路由、LDAP/Wolf 容器均已清理，无本轮待提交草稿 | `.local/consumer-plugin-final-check.json` |

新增与既有真实接口检查合计 **93 组**。浏览器截图位于 `.local/screenshots/consumer-basic-auth-schema.png`、`consumer-jwt-auth-schema.png`、`consumer-jwe-decrypt-schema.png` 与 `consumer-basic-mobile.png`，已经检查桌面和窄屏布局。

收尾读取发现现有 `health-check` 另配有 `limit-count`：每 60 秒 1 次，超限 429。无密钥和错误密钥仍为 401；当前有效密钥已实际得到 200，连续请求则进入现有的 429 限流分支。历史 `.local/health-check-client.json` 示例密钥与当前消费者值不同，不能将该旧文件当作当前有效凭据；消费者记录的最后更新时间为 2026-11-10 22:03:43（北京时间）。本轮没有把现有消费者或路由恢复为历史配置，也没有移除限流。只读复核脚本 `scripts/verify-consumer-final.mjs` 使用当前配置识别认证与限流响应，报告不输出密钥。

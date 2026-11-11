# 生产配置运维指南

| 入口 | 可执行的操作 |
| --- | --- |
| 网关配置 → 共享策略 | 编辑 Plugin Config、Global Rule 和 Plugin Metadata，查看已发布配置、直接引用和依赖。全局规则的影响范围列出集群 HTTP 路由，元数据按插件名查找直接使用它的配置。 |
| 网关配置 → 扩展资源 | 管理 Service、Stream Route、Proto、Secret 管理器、消费者组和独立 Credential。服务可引用共享上游，Proto 可编辑协议文本，独立凭据先选消费者再创建。同一个消费者可维护多个凭据 ID。Secret 支持 Vault、AWS 和 GCP 配置。 |
| 扩展资源 → TLS 证书 | 查看公开证书配置和引用。APISIX 3.19 的 SSL GET 会省略私钥，控制台只允许把证书作为目标环境引用。 |
| 变更管理 → 环境迁移 | 选择多个源资源、读取依赖、导入或下载 JSON 配置包，映射目标 ID、域名和节点。预览逐字段差异、处理冲突，再批量生成草稿。 |
| 变更管理 → 配置诊断 | 输入方法、域名、路径，查看候选路由名称和 ID、优先级、服务/上游、配置中的插件和缺失引用。标记需要运行时求值的表达式、来源地址、脚本和参数化路径。仅在点击分析时查询 Admin API。 |

### 在一条路由上复用多个插件

APISIX 3.19 的路由字段 `plugin_config_id` 接受一个字符串 ID 或正整数 ID。一个 Plugin Config 的 `plugins` 对象可以同时包含多个插件。[APISIX 路由 Schema](https://github.com/apache/apisix/blob/3.19.0/apisix/schema_def.lua#L657)

1. 在「共享策略 → 共享插件配置」新建或编辑一份配置。例如加入 `request-id` 生成请求 ID，再加入 `response-rewrite` 设置响应头。保存并发布这份共享配置。
2. 在「路由管理 → 编辑 → 插件配置 → 引用插件配置」按 ID、描述或插件名搜索，选中后可以看到组内插件。「继承共享配置」表示沿用该组的设置，「路由覆盖」表示同名插件采用路由上的完整配置。路由停用同名插件时会显示「已停用」。
3. 保存并发布路由后，后续单独发布或回退共享配置，会影响引用它的路由。「管理共享配置」在新标签页打开当前集群的配置列表；返回路由后可点击「刷新共享配置」检查最新内容。解除引用后，路由自身配置的插件仍然保留。

### 从开发环境迁移到预发

1. 顶栏切到开发环境，打开「环境迁移」，选择路由并点击「读取资源及依赖」。展开范围包括服务、共享插件配置、上游以及 gRPC 转码插件引用的 Proto。界面可下载配置包，也可在其他控制台导入相同格式的 JSON。
2. 选择目标集群。资源映射按源类型和 ID 填写，例如 `{"services/order-dev":"order-stage"}`。域名映射可填 `{"dev.example":"stage.example"}`，上游节点映射可填 `{"echo:80":"echo-staging:80"}`。配置包包含 `format` 和 `items`，每项保留 `kind`、`id` 和 `value`。一次最多 50 项，含自动展开的依赖。
3. 点击「预览目标差异」。同 ID 相同配置自动跳过。遇到差异，可复用目标配置、指定覆盖，或映射为新 ID。不同 ID 的同名资源会列出目标 ID，选择「允许新建同名资源」后才会新建。
4. 检查引用和已知敏感字段。源端导出的密钥字段使用 `${dashboard:keep-secret}` 占位。更新已有资源时可保留目标值，新建时须填写目标环境的 `$secret://` 或 `$env://` 引用。证书、凭据和 Secret 管理器在目标环境单独准备。控制台校验显式 Secret 管理器引用，环境变量的实际值由网关运行时解析。
5. 「批量生成草稿」会重新读取目标基线，在同一个数据库事务中保存。预览过期或任何一项已有活动草稿时整批停止。打开目标草稿箱，勾选本批草稿创建变更，按现有流程校验、发布或生成回退。网关逐资源写入，发布详情显示每项结果。
6. 共享策略和扩展资源的普通编辑也可生成新增、修改、删除草稿。敏感值沿用加密快照和脱敏差异。编辑、发布、回退沿用目标集群对应权限，只读成员可查看依赖并预览差异。

可迁移类型为 `routes`、`services`、`upstreams`、`plugin_configs`、`protos`、`stream_routes`。全局规则和插件元数据在所属集群内审查发布。HTTP-only 集群会明确提示 Stream 模式未启用。配置诊断给出候选项，最终命中、插件是否拦截及业务健康由实际请求决定。Dashboard 不在数据面安装采集插件。

### 管理接口

以下路径以 `/api/v1/clusters/{cluster}` 为前缀。配置包和接口返回均使用当前账号的集群授权，POST 请求沿用会话及 CSRF 校验。

| 方法与路径 | 入参及结果 |
| --- | --- |
| `GET /resources/{kind}/{id}/impact` | 返回 `dependencies` 和 `references` 两组资源 ID。Credential 使用 `消费者:凭据ID`，Secret 使用 `管理器:配置ID`。列举凭据时使用 `GET /resources/credentials?owner=消费者`。 |
| `POST /export` | `roots` 是由 `kind` 和 `id` 组成的数组，返回含依赖的脱敏配置包。 |
| `POST /transfer/preview` | 输入 `bundle`，可指定 `ids`、`hosts`、`nodes`、`strategies`。返回逐项动作、差异、依赖、可提交状态 `ready` 和预览令牌 `token`。 |
| `POST /transfer/stage` | 向同一目标提交相同输入及令牌，需要编辑权限。成功返回 `draft_ids`，之后使用现有变更集接口发布。 |

### P1 验收与复测

双环境验收使用 APISIX 3.19.0、独立 etcd 和 PostgreSQL 16。先按 [部署说明](../README.md#部署方式) 启动开发、预发配套环境，再串行运行 `node scripts/test-operations.mjs`、`node scripts/test-access.mjs` 和 `npm run test:e2e`。验收前检查本机两条集群连接的地址和环境。脚本临时创建带唯一 ID 的资源，借用尚未配置的日志插件元数据 ID，结束后清理网关配置，数据库保留发布与回退记录。

| 验收面 | 检查内容 |
| --- | --- |
| 共享策略与扩展资源 | 一批草稿按依赖排序发布并回读，独立凭据认证、服务转发、共享认证策略和限定到测试 URI 的全局响应头通过实际代理验证。Secret 管理器测试覆盖配置保存和读回脱敏，外部云和 Vault 服务连通性留给部署环境验证。 |
| 环境迁移 | 递归导出、目标 ID 和节点替换、源密钥被目标拒绝、目标身份访问预发 echo、敏感字段占位保留、同名/同 ID 冲突、依赖缺失、预览令牌失效、草稿冲突整批回滚及两个网关的发布回退。 |
| 权限与浏览器 | 验证按源集群读取、按目标集群预览和编辑权限。浏览器覆盖共享策略草稿的创建和续编、配置文件导入下载、目标差异以及按 `/health` 查询候选路由。 |
| Stream | 配套开发网关保持 HTTP-only。独立测试栈通过 TCP 监听端口转发到 nginx，随后删除并回读 Stream Route。该测试栈没有主机端口映射。 |

**2026-11-11 本地验收结果**

- P1 双环境集成 16 组全部通过。实际将 15 份草稿按依赖顺序发布；在预览后另行发布目标路由修改，原令牌重新提交得到 HTTP 409。两把开发凭据均能通过认证，迁移后只有预发自己的凭据能访问预发 echo。
- 浏览器全量回归 52 项通过，前端单元测试 56 项通过。TypeScript 类型检查、生产构建、Prettier 检查、Go 竞态测试及 `go vet` 通过。Go 默认跳过需要独立环境的 Stream 用例，该用例在专用 Docker 网络内另行实测通过。
- 既有基础集成 14 组、权限与审计 8 组、高级路由 14 组、消费者凭据 10 组通过。P1 权限用例覆盖未授权源集群导出、未授权目标预览，以及允许预览的只读成员提交草稿时被拒绝。
- 清理后，两个环境的路由、上游、消费者、服务及 Plugin Config 指纹与已有基线一致。开发 `/health` 无密钥返回 401、有效密钥返回 200，预发 `/__env/staging` 返回 200。本轮临时资源已清理，早期调试和正式验收的操作历史保留。

独立运行 Stream 验收时，使用已缓存依赖的 Go 模块卷 `apisix-dashboard-next-go-mod` 和构建缓存卷 `apisix-dashboard-next-go-build`。执行后清理测试栈。

```powershell
docker compose -f tests/stream/compose.yaml up --abort-on-container-exit --exit-code-from verify --attach verify
docker compose -f tests/stream/compose.yaml down -v
```

### 从带流量图的版本升级

使用本项目 Compose 的环境更新代码后，运行 `docker compose --profile gateway up -d --build`。同时使用测试网关的，再运行 `docker compose -f compose.staging.yaml up -d`。Compose 会按新配置重建受影响的容器并沿用已有数据卷。

如果曾按旧版说明手动接入外部数据面，在各节点解除 `dashboard_flow` 的 Lua hook 或自定义 hook 中对它的调用，移除专用 Lua 路径、`dashboard-flow.conf` include 和快照套接字挂载，再按集群原有流程逐节点重载。控制台部署可移除 `DASHBOARD_FLOW_SOURCES` 和对应挂载。普通 Admin API 接入仅需升级控制台。

## 当前边界

- 已实际验证 **APISIX 3.14.1 和 3.19.0 + etcd + PostgreSQL 16**，配套网关默认 3.19.0，可通过 `APISIX_IMAGE` 指定镜像。按 3.x Admin API 设计，但未声称支持所有 3.x 发行版；生产接入前应增加目标版本的集成矩阵。
- 本版支持多账号登录、按集群独立授权与操作审计。管理员在「系统设置 → 用户与权限」管理账号。配置只读、草稿编辑、发布、回退、审计的权限矩阵及测试见 [权限与审计](access-control.md)。SSO、MFA、双人审批和 GitOps 留待企业协作阶段。消费者同时支持内嵌认证、独立 Credential 和消费者组。TLS 证书提供只读查询与目标环境引用。本次消费者插件矩阵实测 APISIX 3.19.0；LDAP 使用真实 OpenLDAP，Wolf 使用权限检查协议测试服务，未连接真实 Wolf 平台。
- 发布按资源执行，不是跨资源原子事务。部分失败时记录已应用项目并停止；回退也可能发生冲突，不会强制覆盖外部修改。
- 配置哈希检查和 PostgreSQL 集群锁保护控制台自身并发；其他 Admin API 写入方仍有检查与写入之间的时间窗口。需要严格单写者约束时，应统一写入入口。
- 「发布成功」表示 Admin API 写入并回读确认，不表示所有数据面节点已生效或业务健康。测试用例另行验证了本地代理请求。
- 插件表单支持嵌套对象/数组，联合类型、深层引用或自定义结构保留字段级 JSON。实体 Schema、插件 JSON Schema 与 Lua 自定义 `check_schema` 不完全相同；已额外检查表达式结构，最终仍以 APISIX 实际写入结果为准。
- 常见密钥、认证头和 cookie 字段，以及 Schema 声明的 `encrypt_fields`、属性 `writeOnly/format: password` 脱敏；敏感字段路径随草稿与发布快照加密保存。自由文本、脚本及未声明的自定义秘密仍需自行管理，不应把秘密放入名称、说明和日志内容。
- Monaco 按需加载，当前编辑器分包较大；后续可继续做字体和编辑器功能裁剪。

生产部署应提供 HTTPS、设置 `SECURE_COOKIE=true`、限制管理端口网络范围，并配置数据库与加密密钥备份；本地配套 etcd / echo 配置仅供开发验收。

详见 [架构与发布语义](architecture.md)、[接口约定](api.md)、[基础验收记录](verification.md) 和 [高级路由实现与验收](route-editor-verification.md)。

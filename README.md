# APISIX Dashboard Next

面向 Apache APISIX 3.x 的独立配置控制台。运维人员可以在开发、预发和生产集群之间切换，把路由、上游和插件的修改保存为草稿，审查差异后发布，并按发布记录回退。Dashboard 通过 Admin API 管理配置，业务流量直接经过 APISIX，数据面无需安装采集插件。

**V1.0.0** · 简体中文 / English · 浅色 / 深色主题 · React + TypeScript / Go / PostgreSQL

配套演示网关为 APISIX 3.19.0，路由编辑另有 3.14.1 的验收记录。各集群的可用资源和插件字段以该版本返回的 Schema 为准。

[部署方式](#部署方式) · [主要功能](#主要功能) · [界面截图](#界面截图) · [开发与测试](#开发与测试)

![配置工作台，可直接打开当前环境的网关配置、待审草稿和最近发布](docs/screenshots/workspace.png)

## 部署方式

需要 Docker Engine 或 Docker Desktop，以及 Docker Compose v2。Dashboard 镜像在构建时编译 Go 服务和前端，最终由同一容器提供网页与 API。仅在运行示例数据或前端开发脚本时需要主机安装 Node.js 24+。

### 1. 获取 V1.0.0 并初始化

~~~sh
git clone --branch V1.0.0 https://github.com/zjq-coder/apisix-dashborad-new.git
cd apisix-dashborad-new
~~~

在项目根目录按系统执行一条命令。初始化会生成独立的登录密码、数据库密码和加密密钥；再次执行会保留已有 `.env`。

| 系统 | 初始化命令 |
| --- | --- |
| Windows PowerShell | `.\scripts\init-dev.ps1` |
| Linux / macOS（需要 OpenSSL） | `sh scripts/init-dev.sh` |

### 2A. 接入已有 APISIX 集群

~~~sh
docker compose up -d --build
docker compose ps
~~~

1. 打开 [Dashboard](http://127.0.0.1:18080)，使用项目根目录 `.env` 中的 `DASHBOARD_USERNAME` 和 `DASHBOARD_PASSWORD` 登录。浏览器访问 [/healthz](http://127.0.0.1:18080/healthz) 可检查服务与数据库连接。
2. 在「集群连接」添加环境，填写 Admin API 地址和对应的 Admin Key。地址必须能从 **Dashboard 容器**访问。例如，多个控制面节点共同管理同一套配置时，可填内网负载均衡地址 `https://apisix-admin.example.internal:9180`，由负载均衡转发到提供 Admin API 的节点。每套独立配置建立一条集群连接。
3. 执行连接检测，在顶栏选中该环境，打开「路由管理」核对现有路由。首次接入可将连接设为只读，先核对地址、版本和资源，再按需要开放发布权限。

### 2B. 在本机启动演示网关

~~~sh
docker compose --profile gateway up -d --build
node scripts/seed-sandbox.mjs
~~~

此方式同时启动 Dashboard、PostgreSQL、APISIX、etcd 和 nginx 示例上游。初始化脚本通过草稿和发布接口补齐 2 个示例上游、4 条路由，跳过已有的同 ID 资源。登录后选择「本地开发网关」，打开 [订单示例接口](http://127.0.0.1:19080/api/orders/hello)，成功时响应包含 `"service":"dashboard-sandbox"`。

| 访问位置 | 默认地址 | 用途 |
| --- | --- | --- |
| 主机浏览器 | `http://127.0.0.1:18080` | Dashboard |
| 主机调用方 | `http://127.0.0.1:19080` | 演示网关业务入口 |
| Dashboard 容器 | `http://apisix:9180` | 配套开发网关的 Admin API |
| 主机调试工具 | `http://127.0.0.1:19180/apisix/admin` | 开发网关 Admin API，使用 `APISIX_ADMIN_KEY` |
| 主机数据库客户端 | `127.0.0.1:15432` | PostgreSQL，默认数据库与用户均为 `dashboard` |

<details>
<summary>可选：启动第二个演示环境，验证环境切换</summary>

先启动上面的开发环境，再在项目根目录执行以下命令。第二套 APISIX 使用独立的 etcd 数据卷和 Admin Key。

~~~sh
node -e "const fs=require('node:fs'); const file='.local/staging.env'; fs.mkdirSync('.local',{recursive:true}); if(!fs.existsSync(file)) fs.writeFileSync(file,'APISIX_ADMIN_KEY='+require('node:crypto').randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600})"
docker compose -f compose.staging.yaml up -d --wait
node scripts/seed-staging.mjs
~~~

在顶栏切换到「本地测试网关」即可看到 `staging-env-check`。打开 [预发示例接口](http://127.0.0.1:29080/__env/staging) 验证。单独停止此环境使用 `docker compose -f compose.staging.yaml stop`。

</details>

### 升级、持久化与生产接入

- **升级与停止**。更新到选定版本后，再运行部署时的 `docker compose up -d --build`；带演示网关时加上 `--profile gateway`。停止并保留数据使用 `docker compose --profile gateway stop`。从早期流量图版本升级的环境可查阅[迁移说明](docs/operations-guide.md#从带流量图的版本升级)。
- **数据库与密钥**。PostgreSQL 16 的命名卷 `dashboard-db` 保存账号、集群连接、草稿、发布和审计。备份 PostgreSQL 时同步保管 `DASHBOARD_ENCRYPTION_KEY`，恢复时使用原密钥解密已有记录。APISIX 自身的配置随网关 etcd 单独备份。
- **HTTPS 与会话**。默认端口只绑定主机回环地址。对外提供 Dashboard 时，在同一主机的反向代理终止 TLS，转发到 `127.0.0.1:18080`，保留原始 Host，通过 HTTPS 登录；在 `.env` 中设置 `SECURE_COOKIE=true` 后执行 `docker compose up -d dashboard`。Admin API 仅允许可信管理网络访问。
- **配置项**。见 [.env.example](.env.example)。`DASHBOARD_ENCRYPTION_KEY` 需要 64 位十六进制字符；`APISIX_IMAGE` 可指定演示网关镜像。首次启动用初始化脚本即可生成 Compose 所需凭据。

## 主要功能

| 功能 | 在界面中可以做什么 |
| --- | --- |
| 多环境与权限 | 切换集群、检测连接、启用只读模式，按账号和集群分配草稿编辑、发布、回退及审计权限。 |
| 路由与上游 | 通过表单或 JSON 设置路径、域名、方法和嵌套条件；配置请求改写、重定向、服务引用、节点权重、负载均衡、重试和健康检查。 |
| 插件与共享配置 | 按官方分类浏览集群已启用的插件，按 Schema 编辑。一条路由可引用一份包含多个插件的 Plugin Config；界面逐项显示继承、路由覆盖与停用状态。 |
| 消费者与凭据 | 维护消费者、消费者组与独立 Credential；在消费者页面配置 API Key、Basic、JWT 等凭据，在路由启用对应插件。已保存的敏感值脱敏显示，支持轮换。 |
| 草稿、差异、发布与回退 | 保存草稿后比较逐字段或 JSON 差异；按集群组织变更，检查基线、Schema 和依赖，再按顺序发布并回读。回退会生成一份可审查的新变更。 |
| 共享策略与扩展资源 | 管理全局规则、插件元数据、Service、Stream Route、Proto 和 Secret 管理器，查看资源依赖。TLS 证书支持查询和目标环境引用。 |
| 迁移与配置诊断 | 连同依赖导出脱敏配置包，映射目标资源 ID、域名和节点，解决冲突后批量生成草稿。输入请求方法、域名、路径，可离线分析候选路由和配置引用。 |
| 操作审计 | 按集群查看配置操作与发布执行记录。管理端持有网关 Admin Key，浏览器使用 Dashboard 会话。 |

**第一次发布**可以从演示环境的 `order-api` 开始：编辑路由描述并保存草稿，在差异页核对改动，创建变更、校验并发布。打开发布详情查看每项回读结果；若要撤销，点击「生成回退变更」，确认差异后发布。多资源变更逐项执行，遇到失败可在详情中查看已应用的项目。

## 界面截图

以下截图取自本地运行的 V1.0.0 开发和预发演示环境。点击图片可查看原图。

| 路由管理 · 已发布的路由、匹配规则与启停状态 | 路由编辑 · 分区表单与实时配置预览 |
| --- | --- |
| [![路由管理列表](docs/screenshots/routes.png)](docs/screenshots/routes.png) | [![订单路由编辑与 JSON 预览](docs/screenshots/route-editor.png)](docs/screenshots/route-editor.png) |
| **插件目录 · 按类别浏览集群启用的插件** | **发布详情 · 查看目标环境、执行结果与回退入口** |
| [![集群插件目录](docs/screenshots/plugins.png)](docs/screenshots/plugins.png) | [![预发环境的已发布变更](docs/screenshots/release.png)](docs/screenshots/release.png) |

## 开发与测试

在仓库根目录执行。开发服务器默认监听 `http://127.0.0.1:5173`，将 `/api` 转发至本机 Dashboard 端口 18080。

~~~sh
npm ci
npm run dev
~~~

| 检查 | 命令与前置条件 |
| --- | --- |
| 前端单元测试、类型、构建、格式 | `npm run test:web`、`npm run typecheck`、`npm run build`、`npm run format:check` |
| Go 后端 | 在 `server/` 运行 `go test -race ./...` 和 `go vet ./...` |
| 路由与真实代理 | 启动并初始化演示网关后运行 `npm run test:integration`、`npm run test:routes` |
| 消费者与插件 | `npm run test:consumers`、`npm run test:consumer-plugins`。后者还会使用 Docker 启动独立的 LDAP 和 Wolf 协议测试服务。 |
| 双环境、权限与浏览器 | 启动并初始化两个演示环境，依次执行 `node scripts/test-operations.mjs`、`node scripts/test-access.mjs`、`npm run test:e2e`。Playwright 默认使用 Edge，可通过 `PLAYWRIGHT_CHANNEL` 切换到已安装的 Chrome。 |

涉及网关写入的验收套件请在配套本地环境**串行**运行。项目代码分别位于 [web/src](web/src) 和 [server](server)。[deploy](deploy) 包含示例网关配置，[scripts](scripts) 和 [tests](tests) 包含初始化及验收工具。

## 进一步阅读

- [生产配置运维指南](docs/operations-guide.md) — 共享插件、扩展资源、迁移冲突、兼容范围与验收记录
- [架构与发布语义](docs/architecture.md) · [管理接口](docs/api.md)
- [账号权限与审计](docs/access-control.md) · [消费者认证配置与验证](docs/consumer-plugin-verification.md) · [高级路由实现与验收](docs/route-editor-verification.md)
- [插件图标来源](web/public/plugin-icons/SOURCES.txt) · [APISIX 官方文档](https://apisix.apache.org/docs/apisix/)

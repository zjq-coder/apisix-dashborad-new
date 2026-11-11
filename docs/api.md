# 控制台 API 约定

前缀 `/api/v1`。JSON 请求和响应。错误为 `{"error":"可读信息"}`，业务对象的字段以 `server/internal/console/model.go` 为准。

## 会话

`POST /login` 接收 `username/password`，返回 `username/role/grants/csrf_token` 并设置 HttpOnly、SameSite=Strict 的会话 Cookie。之后的写请求必须包含 `X-CSRF-Token`。`GET /session` 恢复会话；`POST /logout` 退出。默认会话 12 小时，登录有按来源地址的尝试限制。

## 端点

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET / POST | `/clusters` | 列表 / 接入集群 |
| PUT | `/clusters/{id}` | 更新名称、说明、凭据或只读属性；地址和环境固定 |
| POST | `/clusters/{id}/probe` | 读取资源与插件，返回能力检查和版本 |
| GET | `/clusters/{id}/workspace` | 从 PostgreSQL 读取所选环境最近更新的 4 份待审草稿和最近创建的 4 项变更。返回 `drafts/changes` 元数据数组，空集群返回空数组，未知集群返回 404。配置正文和差异在打开详情时读取。 |
| GET | `/clusters/{id}/resources/{routes\|upstreams\|consumers\|services\|plugin_configs}` | 实时资源列表，响应 `items/total`；后两种仅供读取和引用；消费者按 username 寻址，密钥脱敏 |
| POST | `/clusters/{id}/validate` | 校验未保存的路由/上游/消费者快照，返回 `ok/checks`；不创建草稿或写入网关 |
| GET | `/clusters/{id}/resources/{kind}/{resourceID}` | 资源、配置哈希、修改索引 |
| GET | `/clusters/{id}/plugins` | 已启用插件名称列表 |
| GET | `/clusters/{id}/plugins/catalog` | 当前启用插件的元数据；包含 type/scope、消费者可配置性、消费者 Schema 来源和声明的敏感字段 |
| GET | `/clusters/{id}/plugins/{name}/schema?scope=route\|consumer` | 目标插件在对应上下文中的 Schema，默认 route |
| POST | `/clusters/{id}/plugins/{name}/validate` | 校验插件，接收 `value`、`resource_type: routes\|consumers`（默认 routes）；编辑已有秘密时附 `resource_id` 或 `draft_id`，草稿与目标资源必须一致 |
| GET / POST | `/drafts` | 列表 / 创建草稿；列表支持 `cluster_id` |
| GET / PUT / DELETE | `/drafts/{id}` | 查看 / 更新 / 丢弃草稿 |
| POST | `/drafts/{id}/validate` | 返回 `ok/checks`，不写入网关 |
| GET / POST | `/changesets` | 最近 200 条变更 / 从草稿创建变更；列表支持 `cluster_id` |
| GET | `/changesets/{id}` | 详情、操作与实际执行状态 |
| POST | `/changesets/{id}/validate` | 校验待发布内容 |
| POST | `/changesets/{id}/publish` | 202 接受发布，轮询详情获取结果；最终状态重复调用不重写 |
| POST | `/changesets/{id}/reconcile` | 核对 `unknown` / 中断的 `publishing` 任务 |
| POST | `/changesets/{id}/rollback` | 生成或返回关联的待发布回退变更 |
| POST | `/changesets/{id}/cancel` | 取消尚无已应用/未知操作的变更 |
| GET | `/audit` | 已授权范围内的系统或集群事件；按 ID 倒序，支持精确 `actor/action/outcome/cluster_id`、`limit=1..200`（默认 200）和排他的 `before_id` |
| GET / POST | `/users` | 仅管理员：列出不含凭据的账号元数据 / 创建账号 |
| PUT / DELETE | `/users/{username}` | 仅管理员：完整替换角色、启停状态、集群授权或重置密码 / 删除账号；两者均须提交当前 revision |

## 授权

`grants` 形如 `{"<cluster-id>":["edit","audit"],"<another-id>":[]}`。出现集群 ID 即可读取该集群；未出现则无访问权限。管理员具有全局权限，`grants` 为空对象。创建账号要求 `username/password/role/enabled`；更新时提交 `revision/role/enabled/grants`，省略或留空 `password` 保留当前密码。删除传 `{"revision":当前版本}`。修改、轮换或停用账号会撤销该账号的所有现有会话。账号响应不返回密码、哈希或会话令牌。详见[权限矩阵](access-control.md)。

没有会话为 401；能访问集群但不能执行该操作为 403；无法访问的集群、草稿或变更详情与不存在的对象一样返回 404。省略 `cluster_id` 不会扩大可见范围。

## 草稿请求

未保存配置校验请求：

```json
{
  "resource_type": "routes",
  "resource_id": "orders-api",
  "value": {"uri": "/orders/*", "upstream_id": "orders-upstream"}
}
```

`resource_id` 可省略；已有资源从实时配置恢复密钥占位符，编辑草稿时附 `draft_id`，使用草稿快照恢复密钥。草稿必须属于当前集群、资源类型与 ID。只读集群允许此校验，但仍要求登录、CSRF 与来源检查。校验包括实体 Schema、插件 JSON Schema、表达式结构、上游/服务/共享插件引用；不代表请求流量已经验证，也不会锁定后续发布版本。

草稿创建请求：

```json
{
  "cluster_id": "目标连接 ID",
  "resource_type": "routes",
  "resource_id": "orders-api",
  "action": "create",
  "title": "订单 API",
  "value": {
    "name": "orders-api",
    "uri": "/orders/*",
    "methods": ["GET"],
    "upstream_id": "orders-upstream",
    "plugins": {
      "limit-req": { "rate": 100, "burst": 50, "key": "remote_addr", "rejected_code": 429 }
    }
  }
}
```

修改/删除在线配置须带读取资源时返回的 `base_hash`。更新草稿须带最新 `revision`，目标资源和动作不可更换。`delete` 不传 `value`。资源 ID 为 1–64 位字母、数字、点、下划线或短横线。

消费者使用 `resource_type: "consumers"`，`resource_id` 必须与 `value.username` 一致；用户名支持 1–256 位字母、数字、下划线和短横线（不含点）。认证配置放在 `value.plugins`，例如 `key-auth.key`、`basic-auth.username/password`、`jwt-auth.key/secret/algorithm`。同一消费者可以同时配置多种认证插件与消费者策略。

敏感值在列表、详情、草稿和发布记录中返回 `${dashboard:keep-secret}`；原样提交保留原值，新建字段不能使用占位符。服务端结合字段名规则与 Schema 的 `encrypt_fields`、属性 `writeOnly/format: password` 计算敏感路径，并随加密快照保存，保证发布历史和回退预览沿用相同脱敏规则。

消费者优先使用目标网关 `consumer_schema`；目标明确返回该上下文不支持时使用共享 Schema。目录接口将有消费者 Schema 的插件识别为凭据插件，并兼容 Wolf 的共享 Schema；`multi-auth` 只在路由组合认证，不能作为消费者凭据。JSON Schema 校验外补充 JWT 密钥/公钥与 Base64 要求、JWE 解码后 32 字节要求。发布前检查各认证方式的身份标识重复与消费者组引用，最终写入仍执行 APISIX 自身的 Lua 校验。所有消费者写操作复用草稿/发布流程及只读保护。

创建发布变更：

```json
{
  "draft_ids": ["草稿 ID 1", "草稿 ID 2"],
  "title": "发布订单入口",
  "reason": "新增订单路由与对应上游"
}
```

最多 50 项且必须来自同一集群。校验接口返回 200 时仍需检查 `ok` 和每项 `checks`；正式发布会重新检查，因此预览通过并不保证发布时没有并发冲突。

## 状态码

400 请求参数或 JSON 不合法；401 未登录；403 CSRF 或只读保护；404 不存在；409 草稿版本、在线配置或执行锁冲突；422 插件 Schema 校验失败；502 无法访问目标网关；500 存储异常。接口不回显 Admin Key 或远程错误中的原始敏感配置。

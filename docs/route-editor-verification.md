# 高级路由编辑器实现与验收

日期：2026-11-10。参考已有控制台的路由创建流程，查看和填写未提交的参考表单。实现和写入测试均在本项目独立 Docker 环境中完成。

## 界面与功能

沿用深蓝导航、低饱和主色、浅色/深色主题与卡片布局，将配置按五个工作区组织。右侧持续展示真实待保存 JSON，底部保留保存入口。窄屏标签栏可水平滚动，复杂配置逐级展开。

| 工作区 | 已实现内容 |
| --- | --- |
| 基础与匹配 | 名称、ID、说明、标签、启用状态、WebSocket；多 URI、多 Host、多 IP/CIDR；HTTP 方法与优先级；Query/Header/POST 表单/Cookie/Nginx 变量；AND/OR/!AND/!OR 条件组、否定、数值/文本/布尔/null/数组值；Lua 匹配函数 |
| 上游服务 | 已有服务绑定；独立上游引用、内联上游、继承服务、插件直接响应；roundrobin/chash/ewma/least_conn；哈希来源与键；IPv4/IPv6/域名节点、权重与优先级；服务发现；HTTP/HTTPS/gRPC；三类超时、重试、Host 和连接池 |
| 健康检查 | 主动/被动检查；HTTP/HTTPS/TCP；Host、端口、路径、请求头、TLS 验证、并发和超时；健康/异常状态码、检查间隔、恢复次数、HTTP/TCP 失败和超时阈值。路由内联与独立上游共用组件 |
| 请求处理 | `proxy-rewrite` 的静态/多组正则路径、方法、Host、请求头覆盖/追加/移除；`redirect` 的地址/正则/HTTP 转 HTTPS、301/302/303/307/308、查询参数与 URI 编码 |
| 插件配置 | 目标网关动态插件清单和 Schema；嵌套对象、对象数组、字符串数组、布尔、枚举、数字与文本；复杂联合类型使用字段级 JSON；启停/删除、`_meta.priority` 和 `_meta.filter`；引用已有 Plugin Config |
| 检查与预览 | 配置摘要、完整 JSON、当前未保存快照校验、字段错误定位；保存草稿 → 差异 → 发布校验 → 回读确认 → 生成并发布回退 |

服务与 Plugin Config 仅增加只读查询和引用，未在本次扩展为独立 CRUD 页面。旧版的插件可视化编排画布未复制；插件实际执行仍由 APISIX 阶段及优先级决定。

## 数据正确性处理

- 单项与多项匹配字段互斥：编辑 `uri/uris`、`host/hosts`、`remote_addr/remote_addrs` 时清除另一种表示，保持原有多项格式。
- 表单和 JSON 共用配置对象；未识别字段、节点额外属性、插件元数据及 `false/0` 保留。旧版平铺请求头转为结构化操作时保留原值。
- 不完整/重复的节点、标签、匹配项、无效 JSON 和健康状态码保留在输入框，阻止保存，不会悄悄用上一个有效值保存。
- 字段类型不正确的 JSON 留在 JSON 模式修复，不使整个编辑器崩溃。
- 校验响应关联发起时的配置快照；期间继续编辑时丢弃过期结果，之后修改也使旧结果失效。
- 选择插件后进入配置弹窗时，选择窗口不再抢回焦点，避免刚展开的下拉菜单被关闭；该快速连续操作已额外重复验证三次。
- 未保存校验接口不创建草稿、不修改配置。已有密钥从在线资源或匹配的草稿恢复，校验结果不返回明文。
- 前后端额外检查表达式结构。APISIX 的实体 Schema 会接受单子项显式逻辑组，但实际写入会报 `rule too short`；因此 AND/OR/否定逻辑组必须至少含两条规则。普通单条件数组无需显式分组。
- APISIX 3.19 的 `proxy-rewrite` Schema 没有旧界面的 `scheme` 字段，协议统一在上游设置，避免提供无效操作。

## 自动化用例

| 层级 | 验证内容 |
| --- | --- |
| 前端单元测试 | 39 项：字段往返、未知字段、互斥模式、嵌套表达式、IPv4/IPv6/CIDR、节点数组元数据、0/false、错误导入、健康检查、方法枚举与重定向约束 |
| 后端单元测试 | 23 项，包含加密/脱敏、Schema、并发/冲突、回读、依赖，以及本次的只读引用、缺失服务/插件配置、表达式与插件执行条件；执行竞态检查和 go vet |
| 浏览器回归 | 10 项：基础列表/主题/窄屏；完整发布回退；未保存保护；集群切换与只读入口；复杂路由可视化配置及真实请求；异步校验与无效健康码；服务/共享插件/草稿重开/只读；JSON 往返与错误输入；重定向同步与响应式布局；插件嵌套数组与执行选项 |
| 基础真实网关集成 | 14 组：认证/CSRF、密钥、草稿冲突、联合发布、引用约束、外部修改、只读、回退和审计 |
| 高级真实网关集成 | 14 组：未保存校验、无副作用、非法参数/引用、只读引用、服务与共享插件继承、密钥草稿校验、嵌套条件匹配、正则与请求头变换、重定向、复杂上游 Schema、更新回退的实际代理行为 |

浏览器实际从表单创建多路径/多域名/多来源、嵌套条件、内联上游与主动/被动检查、连接池、请求改写，保存草稿、审查并发布，然后断言请求方法、路径、查询参数、Host、请求头以及不匹配时的 404。最后重新打开配置确认保存结果，并发布回退清理资源。

APISIX `3.14.1-debian` 和 `3.19.0-debian` 均完成基础 14 组 + 高级 14 组真实集成验收，共 56 组版本化执行通过。当前本地环境恢复为 3.19.0。后端 23 项、前端 39 项、类型检查、生产构建、格式检查通过。

最终部署构建的完整浏览器回归结果：**10 / 10 通过**，耗时约 1.4 分钟，报告位于 `playwright-report/index.html`。插件弹窗快速连续操作另有 3 次重复通过；开发模式 JSON 往返用例额外通过。未保留本轮待处理测试草稿，原有业务配置未作为清理目标。

另以填满复杂配置的未保存表单检查 1440 / 768 / 390 像素下五个工作区，共 15 个布局组合，无页面横向溢出，未出现页面运行时错误。深浅主题截图已查看。开发模式下额外验证 JSON 反复切换，修复 Monaco 依赖初始化与首次依赖优化重载；开发代理保留 Host 以通过原有来源校验。

## 复现

启动配套网关并 seed 后，依次运行，避免多个测试同时切换测试集群只读属性：

```powershell
npm run typecheck
npm run test:web
npm run test:integration
npm run test:routes
npm run test:e2e
npm run build
npm run format:check
docker run --rm -v "${PWD}/server:/src" -w /src golang:1.27.3-bookworm go test -race ./...
docker run --rm -v "${PWD}/server:/src" -w /src golang:1.27.3-bookworm go vet ./...
```

`scripts/test-route-editor.mjs` 输出 `.local/route-editor-integration.json`。浏览器生成 `.local/screenshots/v3-*.png`，失败时保留 Playwright 截图和 trace。临时配置自动清理；发布审计历史保留。测试客户端用原生 HTTP 保留自定义 Host，避免当前 Node fetch 忽略 Host 干扰域名匹配验收。

两个版本报告分别保存在 `.local/route-editor-integration-3.14.1.json` 与 `.local/route-editor-integration-3.19.0.json`。最终界面截图为 `.local/screenshots/v3-route-final.png`、`v3-route-final-dark.png` 和 `v3-mobile-final.png`；截图中的示例保持未保存状态，不作为线上业务配置发布。

## 验证边界

- 真实业务请求验证在本机单实例 APISIX 和 echo 上游完成，不是生产或多节点生效保证。
- WebSocket 开关、IPv6 地址、HTTPS/gRPC、外部服务发现、部分哈希/连接池/健康检查字段已验证配置保存与 Schema；未部署对应真实外部服务、TLS/gRPC/WebSocket 服务做端到端协议及故障恢复测试。
- 插件 JSON Schema 与 Lua `check_schema` 仍有差异；正则在目标网关按 PCRE 执行。最终发布可能被网关拒绝，失败记录保留且不会伪报成功。
- POST 表单条件由目标网关的 `post_arg_*` 变量支持，适用于 `application/x-www-form-urlencoded`；不等同于任意 JSON Body 条件编辑器。
- 未验证全部 3.x 发行版或所有自定义插件。插件能力以接入集群返回的清单与 Schema 为准，复杂结构提供 JSON 保留与编辑。

官方语义参考：[Admin API](https://apisix.apache.org/docs/apisix/admin-api/)、[proxy-rewrite](https://apisix.apache.org/docs/apisix/plugins/proxy-rewrite/)、[redirect](https://apisix.apache.org/docs/apisix/plugins/redirect/)、[lua-resty-expr](https://github.com/api7/lua-resty-expr)。

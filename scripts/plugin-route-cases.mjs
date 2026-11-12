import assert from 'node:assert/strict';

// Each positive assertion names the observable effect, independent of schema acceptance.
export function routeCases({
  peer,
  ip,
  path,
  marker,
  inspectLog,
  events,
  completionKey,
  protoId,
  metrics,
  signingKey,
  brokerName,
  consume,
  streamBody,
  redisHost,
  saml,
}) {
  const cases = {};
  const add = (name, config, effect, test, extra = {}) => {
    cases[name] = { config, effect, test, ...extra };
  };
  const code = (status, options) => async (hit) =>
    assert.equal((await hit(options)).status, status);
  const contains = (status, text, options) => async (hit) => {
    const res = await hit(options);
    assert.equal(res.status, status);
    assert.ok((await res.text()).includes(text), 'missing response marker: ' + text);
  };
  const header =
    (name, expected, options = {}) =>
    async (hit) => {
      const res = await hit(options);
      assert.equal(res.status, 200);
      if (expected instanceof RegExp) assert.match(res.headers.get(name) || '', expected);
      else assert.equal(res.headers.get(name), expected);
    };
  const json = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const chat = json({ model: 'local', messages: [{ role: 'user', content: 'hello' }] });
  const ai = {
    provider: 'openai',
    auth: { header: { Authorization: 'Bearer local-fixture' } },
    options: { model: 'local' },
    override: { endpoint: peer + '/v1/chat/completions' },
  };
  const companion = { plugins: { 'ai-proxy': ai } };
  const peerUp = { type: 'roundrobin', nodes: { [ip + ':8080']: 1 } };
  const batch = { batch_max_size: 1, inactive_timeout: 1 };
  const block = (deny, allow) => async (hit) => {
    await code(403, deny)(hit);
    await contains(200, 'dashboard-sandbox', allow)(hit);
  };
  add(
    'cors',
    { allow_origins: 'https://orders.example.test' },
    '允许来源收到指定 CORS 响应头',
    header('access-control-allow-origin', 'https://orders.example.test', {
      headers: { Origin: 'https://orders.example.test' },
    }),
  );
  add(
    'request-id',
    { header_name: 'X-Audit-Id', include_in_response: true },
    '两个业务请求得到不同请求标识',
    async (hit) => {
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const r = await hit();
        assert.equal(r.status, 200);
        ids.push(r.headers.get('x-audit-id'));
      }
      assert.ok(ids[0] && ids[1] && ids[0] !== ids[1]);
    },
  );
  add(
    'ip-restriction',
    { whitelist: ['192.0.2.10'], message: marker },
    '非白名单地址被拒绝并返回配置的提示',
    contains(403, marker),
  );
  add(
    'ua-restriction',
    { denylist: ['AuditDenied'] },
    '拒绝匹配 UA，其他 UA 访问订单成功',
    block(
      { headers: { 'user-agent': 'AuditDenied' } },
      { headers: { 'user-agent': 'OrdersClient' } },
    ),
  );
  add(
    'referer-restriction',
    { whitelist: ['allowed.example.test'] },
    '拒绝和允许来源分别命中规则',
    block(
      { headers: { referer: 'https://denied.example.test/' } },
      { headers: { referer: 'https://allowed.example.test/' } },
    ),
  );
  add(
    'uri-blocker',
    { block_rules: ['auditblocked'], rejected_code: 451, rejected_msg: marker },
    '只拦截匹配的订单子路径',
    async (hit) => {
      await contains(451, marker, { suffix: '/auditblocked' })(hit);
      await contains(200, 'dashboard-sandbox')(hit);
    },
  );
  add(
    'response-rewrite',
    { status_code: 202, body: marker, headers: { set: { 'X-Edited': 'yes' } } },
    '订单响应状态、正文和头同步改变',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 202);
      assert.equal(await r.text(), marker);
      assert.equal(r.headers.get('x-edited'), 'yes');
    },
  );
  add(
    'proxy-rewrite',
    { uri: '/__inspect/new', method: 'POST', headers: { set: { 'X-Console-Set': marker } } },
    '原订单上游实际收到新方法、路径和请求头',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 200);
      const s = await r.text();
      for (const x of ['method=POST', 'uri=/__inspect/new', 'set=' + marker])
        assert.ok(s.includes(x));
    },
  );
  add(
    'redirect',
    { uri: '/orders-v2', ret_code: 307 },
    'Location 与重定向状态一致',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 307);
      assert.ok(r.headers.get('location').endsWith('/orders-v2'));
    },
  );
  add(
    'fault-injection',
    { abort: { http_status: 418, body: marker } },
    '按配置直接返回故障码及正文',
    contains(418, marker),
  );
  add(
    'mocking',
    { response_status: 201, response_example: marker, content_type: 'text/plain' },
    '直接返回设定的模拟订单',
    contains(201, marker),
  );
  add('echo', { body: marker }, '响应正文使用插件配置', contains(200, marker));
  add(
    'body-transformer',
    { response: { input_format: 'json', template: 'order={{service}}' } },
    '响应模板读到真实订单上游的 service',
    contains(200, 'order=dashboard-sandbox'),
  );
  add(
    'gzip',
    { min_length: 1, types: ['application/json'], comp_level: 3 },
    '协商 gzip 后响应可解压为订单 JSON',
    async (hit) => {
      const r = await hit({ headers: { 'accept-encoding': 'gzip' } });
      assert.equal(r.headers.get('content-encoding'), 'gzip');
      const { gunzipSync } = await import('node:zlib');
      assert.equal(
        JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer()))).service,
        'dashboard-sandbox',
      );
    },
  );
  add(
    'request-validation',
    { body_schema: { type: 'object', required: ['order'] }, rejected_code: 422 },
    '缺少 order 返回 422，合法订单到达上游',
    async (hit) => {
      await code(422, json({}))(hit);
      await contains(200, 'dashboard-sandbox', json({ order: 123 }))(hit);
    },
  );
  add(
    'oas-validator',
    {
      spec: JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Orders', version: '1' },
        paths: {
          [path]: {
            get: {
              parameters: [
                { name: 'order', in: 'query', required: true, schema: { type: 'integer' } },
              ],
              responses: { 200: { description: 'OK' } },
            },
          },
        },
      }),
      rejection_status_code: 422,
    },
    'OpenAPI 必填查询参数缺失和合法时结果不同',
    async (hit) => {
      await code(422)(hit);
      await contains(200, 'dashboard-sandbox', { suffix: '?order=7' })(hit);
    },
  );
  add(
    'limit-count',
    { count: 1, time_window: 60, key: 'remote_addr', rejected_code: 429 },
    '第二次请求超过计数配额',
    async (hit) => {
      await code(200)(hit);
      await code(429)(hit);
    },
  );
  add(
    'limit-req',
    { rate: 1, burst: 0, key: 'remote_addr', rejected_code: 429 },
    '连续请求超过速率阈值',
    async (hit) => {
      await code(200)(hit);
      await code(429)(hit);
    },
  );
  add(
    'limit-conn',
    { conn: 1, burst: 0, default_conn_delay: 0.1, key: 'remote_addr', rejected_code: 429 },
    '并发时仅一个慢请求获准',
    async (hit) => {
      const codes = await Promise.all([hit(), hit(), hit()].map(async (x) => (await x).status));
      assert.deepEqual(codes.sort(), [200, 429, 429]);
    },
    { upstream: peerUp, plugins: { 'proxy-rewrite': { uri: '/slow' } } },
  );
  add(
    'proxy-cache',
    { cache_strategy: 'disk', cache_zone: 'disk_cache_one', cache_ttl: 30 },
    '相同订单请求从 MISS 变为 HIT',
    async (hit) => {
      for (const v of ['MISS', 'HIT']) await header('apisix-cache-status', v)(hit);
    },
  );
  add(
    'traffic-split',
    {
      rules: [
        {
          match: [{ vars: [['http_x_lane', '==', 'canary']] }],
          weighted_upstreams: [{ upstream: peerUp, weight: 1 }],
        },
      ],
    },
    '只有带 canary 标记的请求进入第二上游',
    async (hit) => {
      await contains(200, 'dashboard-sandbox')(hit);
      await contains(200, 'plugin-test-peer', { headers: { 'x-lane': 'canary' } })(hit);
    },
  );
  add(
    'traffic-label',
    { rules: [{ actions: [{ set_headers: { 'X-Console-Set': marker } }] }] },
    '订单上游实际收到规则写入的标签头',
    contains(200, 'set=' + marker),
    { plugins: { 'proxy-rewrite': { uri: '/__inspect/label' } } },
  );
  add(
    'real-ip',
    { source: 'http_x_fixture_ip' },
    'APISIX 上下文读取到配置指定的客户端地址',
    header('x-seen-ip', '192.0.2.17', { headers: { 'x-fixture-ip': '192.0.2.17' } }),
    { plugins: { 'response-rewrite': { headers: { set: { 'X-Seen-IP': '$remote_addr' } } } } },
  );
  add(
    'workflow',
    { rules: [{ case: [['http_x_stop', '==', 'yes']], actions: [['return', { code: 409 }]] }] },
    '只有符合工作流条件的订单被拒绝',
    async (hit) => {
      await code(409, { headers: { 'x-stop': 'yes' } })(hit);
      await contains(200, 'dashboard-sandbox')(hit);
    },
  );
  for (const name of ['serverless-pre-function', 'serverless-post-function'])
    add(
      name,
      {
        phase: 'header_filter',
        functions: ['return function() ngx.header["X-Fixture-Phase"] = "verified" end'],
      },
      '在 header_filter 阶段设置测试响应头',
      header('x-fixture-phase', 'verified'),
    );
  add('client-control', { max_body_size: 8 }, '超过配置的请求体大小被拒绝', async (hit) => {
    await code(413, json({ order: 'long-order' }))(hit);
    await code(200, json({}))(hit);
  });
  add(
    'csrf',
    { key: completionKey },
    '首次 GET 设置 CSRF cookie，未带令牌的 POST 被拒绝',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie') || '', /csrf/i);
      await code(401, json({ order: 7 }))(hit);
    },
  );
  add(
    'forward-auth',
    { uri: peer + '/auth', request_headers: ['X-Order-Auth'] },
    '本地认证服务拒绝时返回 403，指定请求头转发并获准后订单返回 200',
    async (hit) => {
      await contains(403, 'fixture-denied')(hit);
      await contains(200, 'dashboard-sandbox', { headers: { 'x-order-auth': 'allow' } })(hit);
    },
  );
  add('opa', { host: peer, policy: 'orders' }, '本地 OPA 协议返回自定义拒绝码', code(418));
  add(
    'authz-casdoor',
    {
      endpoint_addr: peer,
      callback_url: 'http://orders.test/callback',
      client_id: 'orders',
      client_secret: completionKey,
    },
    '无会话时重定向到配置的身份服务',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 302);
      assert.ok(r.headers.get('location').startsWith(peer));
    },
  );
  const bearer = (token) => ({ headers: { authorization: 'Bearer ' + token } });
  add(
    'authz-keycloak',
    { client_id: 'orders', token_endpoint: peer + '/uma', permissions: ['orders#read'] },
    '缺令牌 401，本地 UMA 拒绝时 403、允许时订单上游返回 200',
    async (hit) => {
      await contains(401, 'Missing JWT token')(hit);
      await code(403, bearer('order-denied'))(hit);
      await contains(200, 'dashboard-sandbox', bearer('order-allowed'))(hit);
    },
  );
  add(
    'openid-connect',
    {
      client_id: 'orders',
      client_secret: completionKey,
      discovery: peer + '/discovery',
      introspection_endpoint: peer + '/introspect',
      bearer_only: true,
    },
    '缺少或无效 Bearer 令牌返回 401，introspection 确认的令牌可访问订单',
    async (hit) => {
      await code(401)(hit);
      await code(401, bearer('order-denied'))(hit);
      await contains(200, 'dashboard-sandbox', bearer('order-allowed'))(hit);
    },
  );
  add(
    'cas-auth',
    {
      idp_uri: peer,
      cas_callback_uri: '/cas_callback',
      logout_uri: '/logout',
      cookie: { secret: completionKey },
    },
    '无 CAS 会话时重定向到本地 IdP',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 302);
      assert.ok(r.headers.get('location').includes(ip));
    },
  );
  add(
    'ai-prompt-guard',
    { deny_patterns: ['blocked-order'] },
    '拒绝命中禁用词的提示，允许正常提示',
    async (hit) => {
      await code(400, json({ messages: [{ role: 'user', content: 'blocked-order' }] }))(hit);
      await code(200, chat)(hit);
    },
  );
  for (const name of ['ai-proxy', 'ai-proxy-multi'])
    add(
      name,
      name === 'ai-proxy' ? ai : { instances: [{ ...ai, name: 'orders', weight: 1 }] },
      '请求抵达本地模型协议端，客户端收到 completion',
      contains(200, 'local-answer', chat),
    );
  add(
    'ai-prompt-decorator',
    { prepend: [{ role: 'system', content: marker }] },
    '模型协议端收到追加的 system 消息',
    async (hit) => {
      await code(200, chat)(hit);
      await events((e) => e.url?.includes('/chat/completions') && e.body.includes(marker));
    },
    companion,
  );
  add(
    'ai-prompt-template',
    {
      templates: [
        {
          name: 'order',
          template: { model: 'local', messages: [{ role: 'user', content: 'order-template' }] },
        },
      ],
    },
    '只接受已配置模板，模型端收到展开后的消息',
    async (hit) => {
      await code(400, json({ template_name: 'absent' }))(hit);
      await code(200, json({ template_name: 'order' }))(hit);
      await events((e) => e.body.includes('order-template'));
    },
    companion,
  );
  add(
    'ai-rate-limiting',
    { limit: 2, time_window: 60, rejected_code: 429 },
    '模型响应的 token 使用量触发后续限额',
    async (hit) => {
      await code(200, chat)(hit);
      await code(429, chat)(hit);
    },
    companion,
  );
  add(
    'degraphql',
    { query: 'query { order }' },
    '在上游观察到插件生成的 GraphQL 查询',
    async (hit) => {
      await code(200)(hit);
      await events(
        (e) =>
          decodeURIComponent(e.url || '').includes('order') &&
          (e.body.includes('query') || e.url.includes('query=')),
      );
    },
    { upstream: peerUp },
  );
  for (const name of ['aws-lambda', 'azure-functions', 'openfunction', 'openwhisk'])
    add(
      name,
      name === 'openwhisk'
        ? {
            api_host: peer,
            service_token: 'orders:local-test',
            namespace: 'test',
            action: 'orders',
          }
        : { function_uri: peer + '/function/' + name },
      '测试函数收到请求并将自己的响应返回客户端',
      contains(200, 'plugin-test-peer'),
    );
  add(
    'proxy-mirror',
    { host: peer, path: '/mirror', sample_ratio: 1 },
    '原请求到订单，镜像端实际收到副本',
    async (hit) => {
      await contains(200, 'dashboard-sandbox')(hit);
      await events((e) => e.url?.includes('/mirror'));
    },
  );
  const delivery = async (hit, predicate) => {
    await contains(200, 'dashboard-sandbox')(hit);
    await events(predicate);
  };
  const loggers = {
    'http-logger': { uri: peer + '/http-logs' },
    'tcp-logger': { host: ip, port: 15140 },
    'udp-logger': { host: ip, port: 15141 },
    syslog: { host: ip, port: 15141, sock_type: 'udp', flush_limit: 1 },
    'clickhouse-logger': {
      endpoint_addrs: [peer + '/'],
      database: 'audit',
      logtable: 'orders',
      user: 'default',
      password: 'local-test',
      log_format: { uri: '$request_uri' },
    },
    'elasticsearch-logger': { endpoint_addrs: [peer], field: { index: 'audit-orders' } },
    'loki-logger': { endpoint_addrs: [peer] },
    'splunk-hec-logging': {
      endpoint: { uri: peer + '/services/collector/event', token: 'fixture-token' },
    },
    'skywalking-logger': { endpoint_addr: peer },
  };
  for (const [name, config] of Object.entries(loggers))
    add(name, { ...config, ...batch }, '订单返回成功，接收端取得含本次业务路径的日志', (hit) =>
      delivery(hit, (e) => e.body.includes(path)),
    );
  add(
    'zipkin',
    { endpoint: peer + '/api/v2/spans', sample_ratio: 1 },
    '接收端取得该请求的 Zipkin span',
    (hit) => delivery(hit, (e) => e.url === '/api/v2/spans' && e.body.includes(path)),
  );
  add(
    'file-logger',
    { path: '/tmp/' + marker + '.log' },
    '网关测试日志文件包含订单请求路径',
    async (hit) => {
      await code(200)(hit);
      await inspectLog(path);
    },
  );
  add(
    'api-breaker',
    {
      break_response_code: 503,
      break_response_body: marker,
      unhealthy: { http_statuses: [500], failures: 1 },
    },
    '首次上游返回 500，后续请求触发熔断并返回指定正文',
    async (hit) => {
      await code(500)(hit);
      await contains(503, marker)(hit);
    },
    { upstream: peerUp, plugins: { 'proxy-rewrite': { uri: '/broken' } } },
  );
  add(
    'authz-casbin',
    {
      username: 'x-user',
      model:
        '[request_definition]\nr = sub, obj, act\n[policy_definition]\np = sub, obj, act\n[policy_effect]\ne = some(where (p.eft == allow))\n[matchers]\nm = r.sub == p.sub && r.obj == p.obj && r.act == p.act',
      policy: 'p, alice, ' + path + ', GET',
    },
    '同一订单路径按请求用户匹配策略',
    block({ headers: { 'x-user': 'bob' } }, { headers: { 'x-user': 'alice' } }),
  );
  add(
    'ai-request-rewrite',
    { ...ai, prompt: 'Rewrite the order reference' },
    '本地模型返回的内容替换发往上游的请求正文',
    async (hit) => {
      await code(200, json({ order: 1 }))(hit);
      await events((e) => e.url === path && e.body === 'local-answer');
    },
    { upstream: peerUp },
  );
  add(
    'ai-rag',
    {
      embeddings_provider: {
        azure_openai: { endpoint: peer + '/embeddings', api_key: completionKey },
      },
      vector_search_provider: {
        azure_ai_search: { endpoint: peer + '/docs/search', api_key: completionKey },
      },
    },
    '经过向量检索，模型请求含本地检索到的订单内容',
    async (hit) => {
      await code(
        200,
        json({
          model: 'local',
          messages: [{ role: 'user', content: 'order' }],
          ai_rag: { embeddings: { input: 'order' }, vector_search: { fields: 'content' } },
        }),
      )(hit);
      await events(
        (e) => e.url?.includes('/chat/completions') && e.body.includes('local-rag-context'),
      );
    },
    companion,
  );
  add(
    'ai-aws-content-moderation',
    {
      comprehend: {
        region: 'us-east-1',
        endpoint: peer,
        access_key_id: 'fixture-only',
        secret_access_key: completionKey,
      },
      check_response: false,
      deny_code: 451,
    },
    '本地 Comprehend 协议返回高风险评分触发 451',
    async (hit) => {
      await code(451, chat)(hit);
      await events((e) => e.body.includes('TextSegments'));
    },
    companion,
  );
  add(
    'ai-aliyun-content-moderation',
    {
      region_id: 'cn-shanghai',
      endpoint: peer,
      access_key_id: 'fixture-only',
      access_key_secret: completionKey,
      check_response: false,
      deny_code: 451,
    },
    '本地内容审核协议返回高风险结果触发拒绝',
    async (hit) => {
      await code(451, chat)(hit);
      await events(
        (e) => e.protocol === 'http' && (e.body.includes('hello') || e.url.includes('Service')),
      );
    },
    companion,
  );
  add(
    'ai-lakera-guard',
    { api_key: completionKey, lakera_endpoint: peer + '/lakera', deny_code: 451 },
    '本地 Guard 协议标记请求后返回拒绝状态',
    code(451, chat),
    companion,
  );
  add(
    'lago',
    {
      endpoint_addrs: [peer],
      token: completionKey,
      event_transaction_id: '$request_id',
      event_subscription_id: 'order-account',
      event_code: marker,
      ...batch,
    },
    '本地计费接收端收到配置的事件名和订阅 ID',
    (hit) => delivery(hit, (e) => e.body.includes(marker) && e.body.includes('order-account')),
  );
  add(
    'google-cloud-logging',
    {
      auth_config: {
        client_email: 'orders@example.test',
        private_key: signingKey,
        project_id: 'orders-test',
        token_uri: peer + '/oauth/token',
        entries_uri: peer + '/entries',
      },
      ...batch,
    },
    '本地 OAuth 签发令牌后，日志到达 entries 接口',
    (hit) => delivery(hit, (e) => e.url === '/entries' && e.body.includes(path)),
  );
  add(
    'kafka-logger',
    {
      brokers: [{ host: brokerName, port: 9092 }],
      kafka_topic: protoId,
      producer_type: 'sync',
      ...batch,
    },
    '从独立 Kafka broker 的指定主题消费到订单日志',
    async (hit) => {
      await code(200)(hit);
      assert.ok((await consume()).includes(path));
    },
  );
  add(
    'rocketmq-logger',
    { nameserver_list: [ip + ':19876'], topic: 'Orders', ...batch },
    '查找测试主题后，RocketMQ 协议端实际收到含订单路径的消息帧',
    (hit) => delivery(hit, (e) => e.protocol === 'rocketmq' && e.body.includes(path)),
  );
  add(
    'sls-logger',
    {
      host: ip,
      port: 16514,
      project: 'fixture',
      logstore: 'orders',
      access_key_id: 'fixture-only',
      access_key_secret: completionKey,
      ssl_verify: false,
      ...batch,
    },
    'TLS 接收端取得含订单路径的 RFC5424 日志',
    (hit) => delivery(hit, (e) => e.protocol === 'tcp-tls' && e.body.includes(path)),
  );
  add(
    'tencent-cloud-cls',
    {
      scheme: 'http',
      cls_host: ip + ':8080',
      cls_topic: 'orders',
      secret_id: 'fixture-only',
      secret_key: completionKey,
      ...batch,
    },
    '本地 CLS 接口收到日志上传请求',
    (hit) => delivery(hit, (e) => e.url?.includes('structuredlog') && e.body.length > 0),
  );
  add(
    'public-api',
    { uri: '/apisix/plugin/does-not-exist' },
    '公开 API 路由拒绝转发不存在的插件接口',
    code(404),
  );
  add(
    'prometheus',
    { prefer_name: true },
    '指标导出端出现本次订单路由和 HTTP 200 计数',
    async (hit) => {
      await code(200)(hit);
      await metrics(marker);
    },
  );
  const grpcUp = { ...peerUp, scheme: 'grpc', nodes: { [ip + ':8081']: 1 } };
  add(
    'grpc-transcode',
    { proto_id: protoId, service: 'orders.Lookup', method: 'Get' },
    'HTTP JSON 请求经 gRPC 转码，解码返回的 protobuf 字段',
    contains(200, 'grpc-order', json({ id: '123' })),
    { upstream: grpcUp },
  );
  add(
    'grpc-web',
    {},
    '浏览器 gRPC-Web 帧到达 HTTP/2 服务，客户端收到 protobuf 消息及成功 trailer',
    async (hit) => {
      const r = await hit({
        method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
        body: Buffer.from([0, 0, 0, 0, 3, 10, 1, 49]),
      });
      assert.equal(r.status, 200);
      const data = await r.text();
      assert.ok(data.includes('grpc-order') && /grpc-status:\s*0/.test(data));
    },
    { upstream: grpcUp },
  );
  add(
    'http-dubbo',
    {
      service_name: 'orders.Lookup',
      service_version: '1.0.0',
      method: 'get',
      params_type_desc: 'Ljava/lang/String;',
      serialized: true,
    },
    '本地 Dubbo 协议端接到服务和方法，返回真实二进制帧',
    async (hit) => {
      await contains(200, 'local-dubbo-order', { method: 'POST', body: '"order-1"' })(hit);
      await events((e) => e.protocol === 'dubbo' && e.body.includes('orders.Lookup'));
    },
    { upstream: { ...peerUp, nodes: { [ip + ':20880']: 1 } } },
  );
  add(
    'example-plugin',
    { i: 1, ip, port: 8080 },
    '示例插件指定的上游处理订单请求',
    contains(200, 'plugin-test-peer'),
  );
  const observeContext = (expression) => ({
    plugins: {
      'serverless-post-function': {
        phase: 'header_filter',
        functions: [
          'return function(conf,ctx) ngx.header["X-Observed-Setting"]=tostring(' +
            expression +
            ') end',
        ],
      },
    },
  });
  add(
    'kafka-proxy',
    { sasl: { username: 'orders', password: completionKey } },
    'WebSocket 经 APISIX 使用 SASL/PLAIN 认证连接真实 Kafka，返回已写入一条订单的分区末尾偏移量 1',
    async () => {
      const topic = Buffer.from(protoId + '-proxy');
      // PubSubReq.sequence=1, field 34 = CmdKafkaListOffset {topic, timestamp:-1}.
      const inner = Buffer.concat([
        Buffer.from([10, topic.length]),
        topic,
        Buffer.from([24, ...Array(9).fill(255), 1]),
      ]);
      const packet = Buffer.concat([Buffer.from([8, 1, 146, 2, inner.length]), inner]);
      const ws = new WebSocket('ws://127.0.0.1:19080' + path);
      ws.binaryType = 'arraybuffer';
      try {
        const answer = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Kafka WebSocket timeout')), 12000);
          ws.onopen = () => ws.send(packet);
          ws.onmessage = (event) => {
            clearTimeout(timer);
            resolve(Buffer.from(event.data));
          };
          ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Kafka WebSocket handshake failed'));
          };
        });
        assert.ok(
          answer.includes(Buffer.from([146, 2, 2, 8, 1])),
          'Unexpected offset response: ' + answer.toString().slice(0, 260),
        );
      } finally {
        ws.close();
      }
    },
    {
      host: '127.0.0.1',
      upstream: { type: 'none', scheme: 'kafka', nodes: { [brokerName + ':9094']: 1 } },
    },
  );
  add(
    'proxy-buffering',
    { disable_proxy_buffering: true },
    '订单请求进入响应阶段时动态关闭代理缓冲',
    header('x-observed-setting', 'true'),
    observeContext('ngx.ctx.disable_proxy_buffering'),
  );
  add(
    'proxy-control',
    { request_buffering: false },
    '客户端尚未发送最后一段请求体时，上游已读到第一段',
    () => streamBody(() => events((e) => e.protocol === 'request-chunk' && e.body === 'part')),
    { upstream: peerUp, plugins: { 'proxy-rewrite': { uri: '/streaming-order' } } },
  );
  for (const name of ['feishu-auth', 'dingtalk-auth']) {
    const config =
      name === 'feishu-auth'
        ? { app_id: 'orders', auth_redirect_uri: peer + '/callback' }
        : { app_key: 'orders' };
    add(
      name,
      {
        ...config,
        app_secret: completionKey,
        secret: completionKey.slice(0, 24),
        redirect_uri: peer + '/login',
      },
      '未登录订单请求携带 state 跳转到配置的授权入口',
      async (hit) => {
        const r = await hit();
        assert.equal(r.status, 302);
        const location = new URL(r.headers.get('location'));
        assert.equal(location.origin, peer);
        assert.ok(location.searchParams.get('state'));
      },
    );
  }
  add(
    'ai-cache',
    { layers: ['exact'], exact: { ttl: 30 }, cache_headers: true, redis_host: redisHost },
    '相同模型请求经独立 Redis 缓存，先 MISS 再 HIT',
    async (hit) => {
      for (const s of ['MISS', 'HIT']) await header('x-ai-cache-status', s, chat)(hit);
    },
    companion,
  );
  add(
    'data-mask',
    { request: [{ type: 'query', name: 'account', action: 'replace', value: 'MASKED' }] },
    '订单日志的请求参数和 URI 中只有替换值',
    async (hit) => {
      await contains(200, 'dashboard-sandbox', { suffix: '?account=private-value' })(hit);
      const record = await inspectLog(path);
      assert.equal(record.request.querystring.account, 'MASKED');
      assert.equal(record.request.uri, path + '?account=MASKED');
    },
    { plugins: { 'file-logger': { path: '/tmp/' + marker + '.log' } } },
  );
  add(
    'graphql-limit-count',
    { count: 1, time_window: 60, key: 'remote_addr', rejected_code: 429 },
    '相同 GraphQL 查询触发配额拒绝',
    async (hit) => {
      const query = json({ query: '{ order }' });
      await code(200, query)(hit);
      await code(429, query)(hit);
    },
  );
  add(
    'graphql-proxy-cache',
    { cache_strategy: 'disk', cache_zone: 'disk_cache_one' },
    '相同 GraphQL 查询命中缓存',
    async (hit) => {
      const query = json({ query: '{ order }' });
      for (const s of ['MISS', 'HIT']) await header('apisix-cache-status', s, query)(hit);
    },
  );
  add(
    'openapi-to-mcp',
    { openapi_url: peer + '/orders-spec', base_url: peer, transport: 'streamable_http' },
    'MCP tools/list 包含测试 OpenAPI 声明的订单操作',
    contains(200, 'lookupOrder', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );
  add(
    'saml-auth',
    {
      sp_issuer: 'orders-test',
      idp_uri: peer + '/saml',
      idp_cert: saml.cert,
      sp_cert: saml.cert,
      sp_private_key: saml.key,
      login_callback_uri: '/saml/login',
      logout_uri: '/saml/logout',
      logout_callback_uri: '/saml/out',
      logout_redirect_uri: '/saml/done',
      secret: completionKey.slice(0, 32),
    },
    '订单访问生成 SAML AuthnRequest 并重定向到指定本地 IdP',
    async (hit) => {
      const r = await hit();
      assert.equal(r.status, 302);
      const target = new URL(r.headers.get('location'));
      assert.equal(target.origin, peer);
      assert.ok(target.searchParams.get('SAMLRequest'));
    },
  );
  add(
    'websocket-proxy',
    { client_max_payload_len: 8, upstream_max_payload_len: 64 },
    '通过真实 WebSocket 连接回显短帧，并关闭超限的连接',
    async () => {
      const ws = new WebSocket('ws://127.0.0.1:19080' + path);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('WebSocket frame limit timed out')),
            5000,
          );
          let echoed = false;
          ws.onopen = () => ws.send('orders');
          ws.onmessage = (e) => {
            if (e.data !== 'orders') {
              clearTimeout(timer);
              return reject(new Error('oversized frame passed'));
            }
            echoed = true;
            ws.send('over-the-limit');
          };
          ws.onclose = () => {
            clearTimeout(timer);
            echoed ? resolve() : reject(new Error('No echo before close'));
          };
        });
      } finally {
        ws.close();
      }
    },
    { host: '127.0.0.1', upstream: { ...peerUp, scheme: 'ws' } },
  );
  for (const name of ['ext-plugin-pre-req', 'ext-plugin-post-req', 'ext-plugin-post-resp'])
    add(
      name,
      { conf: [{ name: 'orders', value: 'test' }], allow_degradation: false },
      '验证未安装外部 Runner 时的故障策略',
      name === 'ext-plugin-post-resp' ? undefined : code(503),
      { limitation: '成功执行外部插件需要兼容的 Plugin Runner' },
    );
  return cases;
}

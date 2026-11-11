import type { JsonObject } from './types';

export const KEEP_SECRET = '${dashboard:keep-secret}';
export interface PluginDefinition {
  name: string;
  type: string;
  scope: string;
  consumer_configurable: boolean;
  consumer_source: 'dedicated' | 'shared' | 'none';
  consumer_secret_fields: string[];
  route_secret_fields: string[];
}
export const authenticationInfo: Record<
  string,
  { name: string; consumer: string; route: string; request: string }
> = {
  'key-auth': {
    name: 'API Key 认证',
    consumer: '设置有效 API Key，调用方在请求中携带该值。',
    route: 'header / query 填参数名称（如 apikey），有效密钥在消费者中设置。',
    request: 'apikey: <API Key>',
  },
  'basic-auth': {
    name: 'HTTP Basic 认证',
    consumer: '设置 Basic 登录用户名与密码。这里的登录用户名可以与消费者用户名不同。',
    route: '路由启用 Basic 认证，登录用户名与密码在消费者中设置。',
    request: 'Authorization: Basic <Base64(登录用户名:密码)>',
  },
  'jwt-auth': {
    name: 'JWT 认证',
    consumer: '设置 key 标识和签名算法。HS 系列填写 secret；RSA / EC / EdDSA 等填写 public_key。',
    route: '配置 Token 读取位置与 key claim。先在消费者中设置 key、签名密钥或公钥。',
    request: 'Authorization: Bearer <已签名的 JWT>',
  },
  'hmac-auth': {
    name: 'HMAC 签名认证',
    consumer: '设置签名标识和共享密钥。不同 APISIX 版本的签名字段与格式以目标 Schema 为准。',
    route: '配置允许的算法、签名请求头及时间偏差；签名标识和密钥在消费者中设置。',
    request:
      'Authorization: Signature keyId="…",algorithm="hmac-sha256",headers="date",signature="…"',
  },
  'jwe-decrypt': {
    name: 'JWE 解密',
    consumer: 'key 对应 Token 的 kid。secret 解码后必须为 32 字节；可选 Base64URL 编码。',
    route: '配置加密 Token 的读取头与解密结果转发头。消费者提供 kid 对应的解密密钥。',
    request: 'Authorization: <JWE compact token，dir / A256GCM>',
  },
  'ldap-auth': {
    name: 'LDAP 认证',
    consumer: '配置目录用户的完整 DN。登录密码由 LDAP 目录管理，不存放在消费者中。',
    route: '配置 LDAP 地址、搜索基准和用户名属性；消费者配置匹配的完整 user_dn。',
    request: 'Authorization: Basic <Base64(目录用户名:目录密码)>',
  },
  'ldap-auth-advanced': {
    name: 'LDAP 高级认证',
    consumer: '配置搜索后得到的完整 user_dn。目录密码仍由 LDAP 服务校验。',
    route:
      '配置 LDAP 搜索、绑定账户和 TLS。consumer_required 开启时，还必须存在对应 user_dn 的消费者。',
    request: 'Authorization: <Basic 或 ldap> <Base64(用户名:密码)，按 header_type 设置>',
  },
  'wolf-rbac': {
    name: 'Wolf 权限认证',
    consumer: '配置应用 appid、Wolf 服务地址及身份头前缀。此插件的消费者与路由共用 Schema。',
    route: '在消费者中配置 appid 和 Wolf 服务地址。客户端携带匹配 appid 的 Wolf Token。',
    request: 'x-rbac-token: V1#<appid>#<Wolf Token>',
  },
};
export const consumerPolicyHints: Record<string, string> = {
  'multi-auth':
    '这里组合多个认证插件；每种认证方式的凭据分别在消费者中配置。任一认证成功即可通过，不要再在路由顶层重复启用同一认证方式。',
  'consumer-restriction':
    '先通过 key-auth、basic-auth 等认证识别消费者，再按消费者名称或其他身份属性配置允许或拒绝名单。',
  acl: '先通过认证识别消费者，并在消费者基本信息中配置 labels；路由用 allow_labels / deny_labels 控制允许或拒绝的标签。',
  'attach-consumer-label':
    '先通过认证识别消费者，并在消费者基本信息中设置标签，再将指定标签写入上游请求头。',
};
export function pluginLabel(name: string) {
  return authenticationInfo[name]?.name || name;
}
export function secretField(path: string, key: string) {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return (
    /password|secret|token|private_key/.test(normalized) ||
    /^(api_?key|client_key|access_key|authorization|proxy_authorization|cookie|set_cookie)$/.test(
      normalized,
    ) ||
    (key === 'key' &&
      path.startsWith('plugins.') &&
      !/^plugins\.limit-(req|count|conn)$/.test(path))
  );
}
export function maskPluginSecrets(
  value: JsonObject,
  definitions: PluginDefinition[] = [],
  consumer = true,
  mask = '••••••（凭据已隐藏）',
): JsonObject {
  const paths = new Set(
    definitions.flatMap((d) =>
      (consumer ? d.consumer_secret_fields : d.route_secret_fields).map(
        (path) => `plugins.${d.name}.${path}`,
      ),
    ),
  );
  const walk = (item: any, path: string): any => {
    if (Array.isArray(item)) return item.map((value, index) => walk(value, `${path}.${index}`));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => {
        const next = path ? `${path}.${key}` : key;
        return [
          key,
          child != null && (secretField(path, key) || paths.has(next)) ? mask : walk(child, next),
        ];
      }),
    );
  };
  return walk(value, '');
}
// Expose active discriminator fields without removing inactive configuration.
export function activeSchema(schema: JsonObject, value: JsonObject): JsonObject {
  const result = {
    ...schema,
    properties: { ...schema.properties },
    required: [...(schema.required || [])],
  };
  const merge = (part: JsonObject) => {
    result.properties = { ...result.properties, ...part.properties };
    result.required = [...new Set([...result.required, ...(part.required || [])])];
  };
  for (const [name, dependency] of Object.entries(schema.dependencies || {})) {
    const current = value[name] ?? schema.properties?.[name]?.default;
    if (
      current === undefined ||
      !dependency ||
      typeof dependency !== 'object' ||
      Array.isArray(dependency)
    )
      continue;
    const definition = dependency as JsonObject;
    merge(definition);
    for (const option of definition.oneOf || definition.anyOf || []) {
      const discriminator = option.properties?.[name];
      if (discriminator?.enum?.includes(current) || discriminator?.const === current) {
        merge(option);
        // The branch restricts validation, not the selector's available choices.
        if (schema.properties?.[name]) result.properties[name] = schema.properties[name];
      }
    }
  }
  return result;
}
export function credentialIssues(name: string, value: JsonObject): string[] {
  const issues: string[] = [];
  if (name === 'jwt-auth') {
    const algorithm = value.algorithm || 'HS256';
    if (typeof algorithm === 'string' && algorithm.startsWith('HS') && !value.secret)
      issues.push('JWT 对称签名算法必须配置 secret');
    if (typeof algorithm === 'string' && !algorithm.startsWith('HS') && !value.public_key)
      issues.push('JWT 非对称签名算法必须配置 public_key');
    if (
      value.base64_secret &&
      typeof value.secret === 'string' &&
      value.secret !== KEEP_SECRET &&
      !/^\$(env|secret):\/\//.test(value.secret)
    ) {
      try {
        atob(value.secret);
      } catch {
        issues.push('启用 base64_secret 时 JWT secret 必须是合法的 Base64 编码');
      }
    }
  }
  if (
    name === 'jwe-decrypt' &&
    typeof value.secret === 'string' &&
    value.secret &&
    value.secret !== KEEP_SECRET &&
    !/^\$(env|secret):\/\//.test(value.secret)
  ) {
    try {
      const length = value.is_base64_encoded
        ? atob(value.secret.replaceAll('-', '+').replaceAll('_', '/')).length
        : new TextEncoder().encode(value.secret).length;
      if (length !== 32) issues.push('JWE secret 解码后必须恰好为 32 字节');
    } catch {
      issues.push('JWE secret 必须是合法的 Base64URL 编码');
    }
  }
  return issues;
}

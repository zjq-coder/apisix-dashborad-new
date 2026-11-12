import guides from '../data/plugin-guides.json';
import englishGuides from '../data/plugin-guides.en.json';
import type { Locale } from '../i18n';
import type { JsonObject } from '../types';

type Guide = {
  overview: string[];
  fields: Partial<Record<'route' | 'consumer', Record<string, string>>>;
  examples: { title: string; anchor: string }[];
};
const guideIndex: Record<string, Guide> = guides;
const englishIndex: Record<string, Guide> = englishGuides;
export const nonRouteSettings: Record<string, string> = {
  ai: '此插件在网关全局优化路由匹配，启用后会自动分析路由。',
  gm: '在网关节点启用国密支持，再配置 SSL 资源的签名证书和加密证书。',
  'ocsp-stapling': '在 SSL 资源的 ocsp_stapling 字段配置证书状态装订，生效时机是 TLS 握手。',
  inspect: '在网关节点的 plugin_attr.inspect 配置诊断钩子。',
  'log-rotate': '在节点的 plugin_attr.log-rotate 设置轮转间隔和保留文件数。',
  'server-info': '在节点配置上报周期，通过 Control API 查看实例信息。',
  'error-log-logger': '在插件元数据中设置错误日志接收端、协议和日志级别。',
  'batch-requests': '在 HTTP 路由上配置 public-api，映射到 /apisix/batch-requests。',
  'node-status': '在 HTTP 路由上配置 public-api，映射到 /apisix/status。',
  'mqtt-proxy': '在 Stream 路由配置 MQTT 协议及 TCP 监听端口。',
};
export const pluginSetup: Record<string, string> = {
  ...nonRouteSettings,
  datadog: '在插件元数据中设置 DogStatsD 接收地址，路由配置决定上报哪些指标。',
  loggly: '在插件元数据中指定接收主机、端口和协议，在路由配置中设置客户令牌。',
  'chaitin-waf': '先在插件元数据中配置 SafeLine 检测节点，再为路由选择拦截或观察模式。',
  'proxy-cache': '缓存区域必须与节点配置和缓存策略匹配。默认磁盘区域为 disk_cache_one。',
  'grpc-transcode': '先发布 Proto 资源，选择 gRPC 上游，并填写协议中的完整服务名称和方法。',
  'ext-plugin-pre-req': '在网关节点启动对应的 Plugin Runner，并使用 Runner 已注册的插件名称。',
};
pluginSetup['ext-plugin-post-req'] = pluginSetup['ext-plugin-pre-req'];
pluginSetup['ext-plugin-post-resp'] = pluginSetup['ext-plugin-pre-req'];
export function pluginGuide(name: string, locale: Locale = 'zh-CN') {
  const index = locale === 'en-US' ? englishIndex : guideIndex;
  return index[/^serverless-(pre|post)-function$/.test(name) ? 'serverless' : name];
}

export function alternativeGroups(schema: JsonObject): string[][] {
  const branches = schema.oneOf || schema.anyOf || [];
  return branches.flatMap((branch: JsonObject) =>
    branch.required?.length ? [branch.required] : alternativeGroups(branch),
  );
}

export function distinctTypes(schema: JsonObject): JsonObject[] {
  const choices: JsonObject[] =
    schema.oneOf ||
    schema.anyOf ||
    (Array.isArray(schema.type) ? schema.type.map((type: string) => ({ type })) : []);
  const types = choices.map((choice) => choice.type);
  return choices.length > 1 &&
    types.every((type) =>
      ['integer', 'string', 'boolean', 'object', 'array', 'number'].includes(type),
    ) &&
    new Set(types.map((type) => (type === 'integer' ? 'number' : type))).size === choices.length
    ? choices
    : [];
}

export function typeMatches(type: string, value: unknown) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

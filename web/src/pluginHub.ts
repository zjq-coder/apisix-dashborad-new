import { translate, type Locale } from './i18n';
import hub from './data/plugin-hub.json';
import documentedExtensions from './data/plugin-doc-extensions.json';
import { pluginDescriptions } from './data/pluginDescriptions';
import { authenticationInfo } from './plugins';

export const hubUrl = 'https://apisix.apache.org/zh/plugins/';
export function officialUrl(url: string, locale: Locale) {
  return locale === 'en-US' ? url.replace('apisix.apache.org/zh/', 'apisix.apache.org/') : url;
}
export const extensionCategory = '集群扩展';
export const hubGroups = hub;

const official = new Map(
  hubGroups.flatMap(({ name: category, plugins }) =>
    Object.entries(plugins).map(([name, icon]) => [name, { category, icon }] as const),
  ),
);
const serverlessNames = ['serverless-pre-function', 'serverless-post-function'];
const catalogOrder = [...official.keys()].flatMap((name) =>
  name === 'serverless' ? [name, ...serverlessNames] : [name],
);
const titles: Record<string, string> = {
  'limit-req': '请求速率限制',
  'limit-count': '请求次数限制',
  'limit-conn': '并发连接限制',
  'proxy-rewrite': '请求改写',
  'response-rewrite': '响应改写',
  cors: '跨域访问',
  'ip-restriction': 'IP 访问限制',
  prometheus: 'Prometheus 指标',
  'request-id': '请求标识',
  'traffic-split': '流量分配',
};

export function pluginTitle(name: string) {
  return authenticationInfo[name]?.name || titles[name] || name;
}

export function pluginDetail(name: string) {
  const canonical = serverlessNames.includes(name) ? 'serverless' : name;
  const info = official.get(canonical);
  return {
    name,
    category: info?.category || extensionCategory,
    icon: `/plugin-icons/${info?.icon || 'img/plugin/apisix.svg'}`,
    docs:
      info || documentedExtensions.includes(canonical)
        ? `https://apisix.apache.org/zh/docs/apisix/plugins/${canonical}/`
        : undefined,
    description:
      pluginDescriptions[name] ||
      authenticationInfo[name]?.route ||
      '由当前集群提供，可查看其配置字段和类型。',
  };
}

export function catalogEntries(enabled: readonly string[]) {
  const remaining = new Set(enabled);
  const ordered: string[] = [];
  for (const name of catalogOrder) {
    if (remaining.delete(name)) ordered.push(name);
  }
  return [...ordered, ...[...remaining].sort()].map(pluginDetail);
}

export function matchesPlugin(plugin: ReturnType<typeof pluginDetail>, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/);
  const labels = [pluginTitle(plugin.name), plugin.category, plugin.description];
  const text = [plugin.name, ...labels, ...labels.map((label) => translate('en-US', label))]
    .join(' ')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

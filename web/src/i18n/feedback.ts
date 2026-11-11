import serverMessages from './feedback.en.json';
import { translate, useLocale, type Locale } from './index';

const server: Record<string, string> = serverMessages;
// These diagnostics contain APISIX field paths, resource IDs, or field labels.
// Only match known console messages. Values supplied by the gateway stay verbatim.
const clientPatterns = [
  '服务返回了非 JSON 响应 ({0})',
  '{0}{1} 字段类型错误，请在 JSON 中修正',
  '插件 {0} 必须是配置对象',
  '{0} 必须是条件数组',
  '{0} 条件不能为空；不限制时请移除 vars 字段',
  '{0} 条件结构或运算符无效',
  '{0} 请填写完整的变量名称',
  '{0} 的 {1} 需要非空数组',
  '{0} 数值比较需要数字',
  '{0} 请填写合法的 IP 或 CIDR',
  '{0} 请填写正则表达式',
  '{0} 与 {1} 不能同时配置',
  '{0} 必须是非空数组',
  '第 {0} 个节点地址或端口无效',
  '请填写第 {0} 个节点的有效地址和非负整数权重',
  '第 {0} 个节点权重需要非负整数',
  '{0} 需要非负数值',
  '{0}.{1}.{2} 需要非负数值',
];
const escapeRegex = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [...new Set([...Object.keys(server), ...clientPatterns])]
  .filter((key) => key.includes('{0}'))
  .map((key) => {
    const literals = key.split(/\{\d+\}/);
    return {
      key,
      anchor: literals.reduce(
        (longest, part) => (part.length > longest.length ? part : longest),
        '',
      ),
      regex: new RegExp('^' + literals.map(escapeRegex).join('(.*?)') + '$', 's'),
    };
  });

export function formatFeedback(locale: Locale, source: string): string {
  if (locale === 'zh-CN' || !source) return source;
  if (Object.hasOwn(server, source)) return server[source];
  const exact = translate(locale, source);
  if (exact !== source) return exact;
  for (const { key, anchor, regex } of rules) {
    if (!source.includes(anchor)) continue;
    const match = regex.exec(source);
    if (!match) continue;
    const values = match.slice(1);
    // Go wraps these three messages around another console or gateway error.
    if (key === '插件 {0}：{1}' || key === '消费者插件 {0}：{1}')
      values[1] = formatFeedback(locale, values[1]);
    if (key === '无法检查服务对上游的引用：{0}') values[0] = formatFeedback(locale, values[0]);
    const template = server[key] ?? translate(locale, key);
    return template.replace(/\{(\d+)\}/g, (_, i) => values[i]);
  }
  return source;
}

export function useFeedback() {
  const locale = useLocale();
  return (source: string) => formatFeedback(locale, source);
}

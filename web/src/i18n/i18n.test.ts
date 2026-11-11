import { describe, expect, it } from 'vitest';
import english from './en.json';
import serverMessages from './feedback.en.json';
import { translate } from './index';
import { formatFeedback } from './feedback';
import { catalogEntries, matchesPlugin, officialUrl, hubUrl } from '../pluginHub';
import { displayTime } from '../types';

describe('console languages', () => {
  it('preserves every numbered placeholder in translations', () => {
    const slots = (text: string) => (text.match(/\{\d+\}/g) || []).sort();
    for (const [source, target] of [
      ...Object.entries(english),
      ...Object.entries(serverMessages),
    ]) {
      expect(target.trim(), source).not.toBe('');
      expect(slots(target), source).toEqual(slots(source));
    }
  });
  it('interpolates user values verbatim in either language', () => {
    const name = '路由管理 {0} $$ $&';
    expect(translate('en-US', '编辑草稿 {0}', name)).toBe('Edit draft ' + name);
    expect(translate('zh-CN', '编辑草稿 {0}', name)).toBe('编辑草稿 ' + name);
    expect(translate('en-US', 'custom-plugin')).toBe('custom-plugin');
    expect(translate('en-US', 'constructor')).toBe('constructor');
  });
  it('translates nested service diagnostics without translating field names or identifiers', () => {
    expect(
      formatFeedback(
        'en-US',
        '消费者插件 basic-auth：字段 密码 不符合 required 约束，请检查必填项、类型和取值',
      ),
    ).toBe(
      'Consumer plugin basic-auth: Field 密码 violates the required constraint. Check required fields, types, and values.',
    );
    expect(formatFeedback('en-US', 'routes/路由管理 · 版本检查')).toBe(
      'routes/路由管理 · Version check',
    );
    expect(formatFeedback('en-US', 'unrecognized gateway error 原始内容')).toBe(
      'unrecognized gateway error 原始内容',
    );
    expect(formatFeedback('zh-CN', '用户名或密码不正确')).toBe('用户名或密码不正确');
    expect(formatFeedback('en-US', '请填写第 2 个节点的有效地址和非负整数权重')).toContain(
      'node 2',
    );
  });
  it('supports search in either language and keeps official links in the selected locale', () => {
    const [plugin] = catalogEntries(['basic-auth']);
    for (const query of ['basic-auth', '认证', 'Authentication', 'HTTP Basic'])
      expect(matchesPlugin(plugin, query)).toBe(true);
    expect(officialUrl(hubUrl, 'en-US')).toBe('https://apisix.apache.org/plugins/');
    expect(officialUrl(plugin.docs!, 'zh-CN')).toBe(plugin.docs);
  });
  it('formats timestamps in the selected locale', () => {
    const timestamp = '2026-11-10T05:30:00Z';
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(displayTime(timestamp, locale)).toBe(
        new Date(timestamp).toLocaleString(locale, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      );
    }
    expect(displayTime(null, 'en-US')).toBe('Not checked yet');
  });
});

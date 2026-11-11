import { describe, expect, it } from 'vitest';
import {
  catalogEntries,
  extensionCategory,
  hubGroups,
  matchesPlugin,
  pluginDetail,
} from './pluginHub';
import { pluginDescriptions } from './data/pluginDescriptions';

describe('official plugin directory', () => {
  it('keeps all nine official categories in source order with their complete membership', () => {
    expect(hubGroups.map((group) => [group.name, Object.keys(group.plugins).length])).toEqual([
      ['流量管理', 13],
      ['请求与响应转换', 10],
      ['认证', 15],
      ['安全', 11],
      ['AI', 10],
      ['可观测性', 24],
      ['Serverless', 6],
      ['其他协议', 4],
      ['通用', 12],
    ]);
    const entries = catalogEntries(hubGroups.flatMap((group) => Object.keys(group.plugins)));
    expect(entries).toHaveLength(105);
    expect(new Set(entries.map((entry) => entry.icon)).size).toBe(63);
    for (const entry of entries) {
      expect(entry.description).toBe(pluginDescriptions[entry.name]);
      expect(entry.docs).toBe(`https://apisix.apache.org/zh/docs/apisix/plugins/${entry.name}/`);
    }
  });

  it('resolves dedicated symbols, integration logos and intentionally shared artwork', () => {
    expect(pluginDetail('request-id')).toMatchObject({
      category: '流量管理',
      icon: '/plugin-icons/symbols/iconrequest-id.svg',
    });
    expect(pluginDetail('authz-casbin').icon).toBe('/plugin-icons/symbols/iconauthz-casbin.svg');
    expect(pluginDetail('grpc-web').icon).toBe('/plugin-icons/img/integrations/grpc.svg');
    expect(pluginDetail('gm')).toMatchObject({
      category: '请求与响应转换',
      icon: '/plugin-icons/img/plugin/apisix.svg',
    });
    expect(pluginDetail('ai-proxy').icon).toBe(pluginDetail('ai-rag').icon);
    expect(pluginDetail('ai-aws-content-moderation').icon).not.toBe(pluginDetail('ai-rag').icon);
  });

  it('orders enabled plugins by the official index and retains distinct cluster extensions', () => {
    const enabled = ['my-plugin-b', 'basic-auth', 'limit-req', 'my-plugin-a', 'basic-auth'];
    const items = catalogEntries(enabled);
    expect(items.map((p) => p.name)).toEqual([
      'limit-req',
      'basic-auth',
      'my-plugin-a',
      'my-plugin-b',
    ]);
    expect(items.at(-1)).toMatchObject({
      category: extensionCategory,
      docs: undefined,
    });
    expect(catalogEntries([])).toEqual([]);
  });

  it('keeps each enabled serverless runtime ID and links both to the official documentation', () => {
    const ids = ['serverless-post-function', 'serverless-pre-function'];
    const entries = catalogEntries(ids);
    expect(entries.map((p) => p.name)).toEqual([
      'serverless-pre-function',
      'serverless-post-function',
    ]);
    expect(
      entries.every((p) => p.category === 'Serverless' && p.docs?.endsWith('/serverless/')),
    ).toBe(true);
    expect(catalogEntries([ids[0]]).map((p) => p.name)).toEqual([ids[0]]);
  });

  it('searches plugin IDs, Chinese purposes, categories and display names', () => {
    expect(matchesPlugin(pluginDetail('basic-auth'), ' Basic  认证 ')).toBe(true);
    expect(matchesPlugin(pluginDetail('limit-req'), '请求速率限制')).toBe(true);
    expect(matchesPlugin(pluginDetail('zipkin'), '可观测性 追踪')).toBe(true);
    expect(
      matchesPlugin(pluginDetail('serverless-post-function'), 'serverless-post-function'),
    ).toBe(true);
    expect(matchesPlugin(pluginDetail('basic-auth'), '无匹配')).toBe(false);
  });
});

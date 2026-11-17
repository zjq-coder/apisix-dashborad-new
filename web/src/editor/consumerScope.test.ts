import { describe, expect, it } from 'vitest';
import { scopeMode } from '../consumerScope';
import { validateConfig } from './config';

describe('consumer access scope', () => {
  it('only exposes unconditional route and service allowlists to the guided control', () => {
    expect(scopeMode()).toBe('none');
    for (const type of ['route_id', 'service_id']) {
      const rule = {
        type,
        whitelist: ['0001', 'orders'],
        rejected_code: 418,
        rejected_msg: 'denied',
      };
      expect(scopeMode(rule)).toBe(type);
      for (const extra of [
        { blacklist: ['other'] },
        { allowed_by_methods: [] },
        { _meta: { disable: true } },
        { _meta: { filter: [['uri', '==', '/orders']] } },
        { extension: true },
        { whitelist: [1] },
      ]) {
        expect(scopeMode({ ...rule, ...extra })).toBe('advanced');
      }
    }
    expect(scopeMode({ whitelist: ['alice'] })).toBe('advanced');
  });
  it('blocks an empty whitelist in both the form and raw JSON publish path', () => {
    const value = {
      username: 'caller',
      plugins: { 'consumer-restriction': { type: 'route_id', whitelist: [] } },
    };
    expect(validateConfig('consumers', value).map((s) => s.path)).toContain(
      'plugins.consumer-restriction.whitelist',
    );
    expect(validateConfig('consumers', { username: 'caller', plugins: {} })).toEqual([]);
  });
});

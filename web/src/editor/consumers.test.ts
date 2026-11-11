import { describe, expect, it } from 'vitest';
import { formTypeErrors, validateConfig } from './config';
import { consumerPreview, KEEP_SECRET } from './ConsumerFields';

describe('consumer credentials', () => {
  it('requires a real key or retained secret and rejects malformed values', () => {
    const value = { username: 'health-client', plugins: { 'key-auth': { key: '' } } };
    expect(
      validateConfig('consumers', value).some((issue) => issue.path === 'plugins.key-auth.key'),
    ).toBe(true);
    value.plugins['key-auth'].key = KEEP_SECRET;
    expect(validateConfig('consumers', value)).toEqual([]);
    expect(validateConfig('consumers', { ...value, username: 'invalid.name' })).not.toEqual([]);
    expect(
      formTypeErrors('consumers', { ...value, plugins: { 'key-auth': { key: 12 } } }),
    ).not.toEqual([]);
    expect(formTypeErrors('consumers', { ...value, plugins: { 'key-auth': null } })).not.toEqual(
      [],
    );
  });
  it('hides the new key in previews without modifying the draft or extensions', () => {
    const value = {
      username: 'client',
      labels: { team: 'platform' },
      plugins: { 'key-auth': { key: 'do-not-show' }, 'limit-count': { count: 10 } },
    };
    const preview = consumerPreview(value);
    expect(JSON.stringify(preview)).not.toContain('do-not-show');
    expect(preview.plugins['limit-count']).toEqual({ count: 10 });
    expect(value.plugins['key-auth'].key).toBe('do-not-show');
  });
});

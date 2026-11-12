import { describe, expect, it } from 'vitest';
import { activeSchema } from '../plugins';
import { hubGroups } from '../pluginHub';
import { alternativeGroups, distinctTypes, pluginGuide, typeMatches } from './pluginGuide';

describe('plugin configuration guide', () => {
  it('covers every official document and separates consumer credentials from route options', () => {
    for (const group of hubGroups)
      for (const name of Object.keys(group.plugins)) expect(pluginGuide(name), name).toBeDefined();
    expect(pluginGuide('serverless-pre-function')).toBe(pluginGuide('serverless-post-function'));
    expect(pluginGuide('key-auth').fields.consumer?.key).toBeTruthy();
    expect(pluginGuide('key-auth').fields.route?.key).toBeUndefined();
    expect(pluginGuide('key-auth').fields.route?.header).toBeTruthy();
    expect(pluginGuide('key-auth', 'en-US').fields.route?.header).toMatch(/header/i);
  });
  it('distinguishes a literal count from a variable and preserves ambiguous object variants', () => {
    const branches = [{ type: 'integer', exclusiveMinimum: 0 }, { type: 'string' }];
    expect(distinctTypes({ oneOf: branches })).toEqual(branches);
    expect(typeMatches('integer', '10')).toBe(false);
    expect(distinctTypes({ anyOf: [{ type: 'object' }, { type: 'object' }] })).toEqual([]);
    expect(
      alternativeGroups({
        oneOf: [
          { anyOf: [{ required: ['limit', 'time_window'] }, { required: ['instances'] }] },
          { required: ['rules'] },
        ],
      }),
    ).toEqual([['limit', 'time_window'], ['instances'], ['rules']]);
  });
  it('shows conditional fields for the selected correction rule', () => {
    const schema = {
      properties: { action: { type: 'string' } },
      allOf: [
        { if: { properties: { action: { const: 'replace' } } }, then: { required: ['value'] } },
      ],
    };
    expect(activeSchema(schema, { action: 'replace' }).required).toContain('value');
    expect(activeSchema(schema, { action: 'remove' }).required).not.toContain('value');
  });
});

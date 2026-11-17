import type { JsonObject } from './types';

export type ScopeType = 'route_id' | 'service_id';
export const restriction = 'consumer-restriction';

// Blacklists, execution conditions and future schema extensions belong in the full editor.
export function scopeMode(policy?: JsonObject): ScopeType | 'none' | 'advanced' {
  if (policy === undefined) return 'none';
  if (
    !policy ||
    !['route_id', 'service_id'].includes(policy.type) ||
    !Array.isArray(policy.whitelist) ||
    !policy.whitelist.every((id: unknown) => typeof id === 'string') ||
    Object.keys(policy).some(
      (k) => !['type', 'whitelist', 'rejected_code', 'rejected_msg', '_meta'].includes(k),
    ) ||
    (policy._meta &&
      (policy._meta.disable || Object.keys(policy._meta).some((key) => key !== 'disable')))
  )
    return 'advanced';
  return policy.type;
}

import type { Resource } from './types';

// Configuration-only matching. APISIX router mode and request-time conditions may narrow the result.
export function routeCandidates(routes: Resource[], method: string, host: string, path: string) {
  const requestPath = path.split('?')[0];
  const hostname = host.trim().replace(/:\d+$/, '').toLowerCase();
  return routes
    .flatMap(({ id, value: v }) => {
      if (v.status === 0 || (v.methods?.length && !v.methods.includes(method.toUpperCase())))
        return [];
      const hosts: string[] = v.hosts || [v.host].filter(Boolean);
      if (
        hosts.length &&
        !hosts.some((h) => {
          const s = h.toLowerCase();
          return s.startsWith('*.') ? hostname.endsWith(s.slice(1)) : s === hostname;
        })
      )
        return [];
      const uris: string[] = v.uris || [v.uri].filter(Boolean);
      const match = uris
        .filter((uri) => {
          if (uri.includes('/:')) {
            const segments = uri.split('/'),
              parts = requestPath.split('/');
            return (
              segments.every(
                (piece, i) =>
                  piece === '*' || (piece.startsWith(':') ? !!parts[i] : piece === parts[i]),
              ) &&
              (segments.at(-1) === '*' || segments.length === parts.length)
            );
          }
          return uri.endsWith('*') ? requestPath.startsWith(uri.slice(0, -1)) : uri === requestPath;
        })
        .sort((a, b) => b.length - a.length)[0];
      if (!match) return [];
      const conditions = ['vars', 'remote_addr', 'remote_addrs', 'filter_func', 'script'].filter(
        (k) => v[k] != null,
      );
      if (match.includes('/:')) conditions.push('radixtree_uri_with_parameter');
      return [
        {
          id,
          name: String(v.name || id),
          match,
          conditions,
          priority: Number(v.priority || 0),
          service: String(v.service_id || ''),
          upstream: String(v.upstream_id || ''),
          inline: !!v.upstream,
          plugins: Object.keys(v.plugins || {}),
          config: String(v.plugin_config_id || ''),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.priority - a.priority || b.match.length - a.match.length || a.id.localeCompare(b.id),
    );
}

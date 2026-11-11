import { pluginDetail } from '../pluginHub';

export function PluginIcon({ name }: { name: string }) {
  return (
    <span className="hub-icon" aria-hidden="true">
      <img src={pluginDetail(name).icon} alt="" decoding="async" />
    </span>
  );
}

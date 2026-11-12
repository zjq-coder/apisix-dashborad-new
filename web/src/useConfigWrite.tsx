import { useEffect, useRef, useState } from 'react';
import { App, Input } from 'antd';
import { api } from './api';
import { useConsole } from './context';
import { useTranslate } from './i18n';
import type { Change, Cluster } from './types';

export function useConfigWrite(target?: Cluster) {
  const { cluster: current, can, refresh, go } = useConsole();
  const cluster = target || current;
  const publish = !!cluster && can('publish', cluster.id);
  const production = publish && cluster?.environment === 'production';
  const [confirmation, setConfirmation] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const t = useTranslate();
  const { message } = App.useApp();
  const ready =
    !!cluster &&
    !cluster.read_only &&
    can('edit', cluster.id) &&
    (!production || confirmation === cluster.name);
  async function write(body: unknown, path = 'config', beforeNavigate?: () => void) {
    if (!cluster || !ready) throw new Error(t('请核对目标集群和写入权限'));
    const change = await api<Pick<Change, 'id' | 'status'>>(
      '/clusters/' + cluster.id + '/' + path + '/' + (publish ? 'apply' : 'submit'),
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: production ? { 'X-Confirm-Cluster': encodeURIComponent(confirmation) } : {},
      },
    );
    let status = change.status;
    // Poll only the management API. Slower releases can continue on the detail page.
    for (let i = 0; status === 'publishing' && i < 8; i++) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        status = (await api<Change>('/changesets/' + change.id)).status;
      } catch {
        break;
      }
    }
    refresh();
    if (!active.current) return { id: change.id, status: 'detached' };
    beforeNavigate?.();
    if (status === 'succeeded') {
      message.success(t('配置已发布到「{0}」', cluster.name));
    } else {
      if (status === 'pending') message.success(t('已提交，等待有发布权限的成员处理'));
      go('/changes/' + change.id, cluster.id);
    }
    setConfirmation('');
    return { id: change.id, status };
  }
  return {
    write,
    ready,
    publish,
    label: publish ? t('保存并发布') : t('提交变更'),
    confirmationField: production && (
      <label className="production-confirm">
        {t('输入集群名称“{0}”确认目标', cluster.name)}
        <Input
          autoComplete="off"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </label>
    ),
  };
}

import { useState } from 'react';
import { Alert, Form, Input, Modal, Tag } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { languageFooter } from '../components/LanguageSwitch';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import { useFeedback } from '../i18n/feedback';
import { useConfigWrite } from '../useConfigWrite';
import { ScopePicker } from './ConsumerScope';
import type { ScopeType } from '../consumerScope';

export function ScopeCredentialDialog({
  source,
  baseHash,
  plugin,
  onClose,
}: {
  source: string;
  baseHash: string;
  plugin: string;
  onClose: () => void;
}) {
  const t = useTranslate();
  const feedback = useFeedback();
  const { go } = useConsole();
  const direct = useConfigWrite();
  const [username, setUsername] = useState(
    () => source.slice(0, 255 - plugin.length) + '-' + plugin,
  );
  const [type, setType] = useState<ScopeType>('route_id');
  const [targets, setTargets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = /^[a-zA-Z0-9_-]{1,256}$/.test(username) && source !== username;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await direct.write(
        { base_hash: baseHash, username, plugin, type, whitelist: targets },
        'consumers/' + encodeURIComponent(source) + '/scope-credential',
      );
      if (result.status === 'succeeded') go('/consumers/' + encodeURIComponent(username) + '/edit');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t('单独授权认证方式')}
      onCancel={() => !busy && onClose()}
      onOk={save}
      footer={languageFooter}
      okText={direct.label}
      cancelText={t('取消')}
      width={640}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      confirmLoading={busy}
      okButtonProps={{ disabled: !direct.ready || !targets.length || !valid || busy }}
      cancelButtonProps={{ disabled: busy }}
    >
      <div className="split-credential-summary">
        <Tag color="blue">{plugin}</Tag>
        <span>{source}</span>
        <ArrowRightOutlined aria-hidden="true" />
        <strong>{username || '…'}</strong>
      </div>
      <p className="scope-description">
        {t(
          '调用方继续使用原凭据，上游收到的 X-Consumer-Username 将变为新用户名。其他认证方式及独立凭据仍属于原消费者。',
        )}
      </p>
      <Form layout="vertical" disabled={busy}>
        <Form.Item
          label={t('独立消费者用户名')}
          validateStatus={valid ? undefined : 'error'}
          help={!valid && t('请填写不同于原消费者的有效用户名')}
        >
          <Input
            aria-label={t('独立消费者用户名')}
            value={username}
            maxLength={256}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Form.Item>
        <ScopePicker
          mode={type}
          targets={targets}
          disabled={busy}
          onChange={(next, ids) => {
            if (next !== 'none') {
              setType(next);
              setTargets(ids);
            }
          }}
        />
      </Form>
      {plugin === 'ldap-auth-advanced' && (
        <p className="scope-precedence">
          {t(
            '请在需要限制访问的 LDAP 路由或服务上开启 consumer_required，网关识别消费者后才会执行白名单。',
          )}
        </p>
      )}
      <p className="scope-precedence">
        {t(
          '新身份沿用消费者组、标签和其他策略，使用本次选择的访问白名单。依赖用户名的上游授权与限流计数需按新身份核对。',
        )}
      </p>
      {direct.confirmationField}
      {error && <Alert type="error" showIcon title={feedback(error)} />}
    </Modal>
  );
}

import { useTranslate } from '../i18n';
import { Alert, Space } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Panel } from '../components/Common';
import { PluginManager } from '../components/PluginManager';
import { maskPluginSecrets, KEEP_SECRET } from '../plugins';
import type { JsonObject } from '../types';

export { KEEP_SECRET };
export const consumerPreview = maskPluginSecrets;

export function ConsumerFields({
  value,
  onChange,
  readOnly,
  resourceId,
  draftId,
}: {
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  readOnly: boolean;
  resourceId?: string;
  draftId?: string;
}) {
  const t = useTranslate();
  return (
    <Panel
      title={
        <Space>
          <SafetyCertificateOutlined aria-hidden="true" />
          {t('认证凭据与消费者策略')}
        </Space>
      }
    >
      <div className="form-panel consumer-credentials">
        <Alert
          type="info"
          showIcon
          title={t('一个消费者可以配置多种认证凭据')}
          description={t(
            '选择目标网关支持的认证插件，填写用户名、密码、密钥或目录身份。凭据保存后脱敏显示，变更需要发布后生效；限流等消费者策略可单独添加。',
          )}
        />
        <PluginManager
          scope="consumer"
          value={value.plugins || {}}
          onChange={(plugins) => onChange({ ...value, plugins })}
          readOnly={readOnly}
          resourceId={resourceId}
          draftId={draftId}
        />
      </div>
    </Panel>
  );
}

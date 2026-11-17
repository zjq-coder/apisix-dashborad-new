import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Radio, Select, Space, Tag } from 'antd';
import {
  ApartmentOutlined,
  BranchesOutlined,
  GlobalOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { scopeMode, type ScopeType } from '../consumerScope';
import { Panel, RequestError } from '../components/Common';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import type { JsonObject, Resource } from '../types';

type ScopeChoice = ScopeType | 'none';
export function ScopePicker({
  mode,
  targets,
  onChange,
  disabled,
  allowUnrestricted = false,
}: {
  mode: ScopeChoice;
  targets: string[];
  onChange: (type: ScopeChoice, ids: string[]) => void;
  disabled: boolean;
  allowUnrestricted?: boolean;
}) {
  const t = useTranslate();
  const targetId = useId();
  const { clusterId } = useConsole();
  const kind = mode === 'service_id' ? 'services' : 'routes';
  const resources = useQuery({
    queryKey: ['resources', clusterId, kind],
    queryFn: ({ signal }) =>
      api<{ items: Resource[] }>(`/clusters/${clusterId}/resources/${kind}`, { signal }),
    enabled: !!clusterId && mode !== 'none',
  });
  const items = mode !== 'none' ? resources.data?.items || [] : [];
  const options = items.map(({ id, value }) => ({
    value: id,
    label: value.name && value.name !== id ? value.name + ' · ' + id : id,
    detail:
      mode === 'route_id'
        ? [value.uri, ...(value.uris || [])].filter(Boolean).join(', ')
        : value.desc || '',
  }));
  const names = new Set(options.map((item) => item.value));
  const missing = resources.isSuccess ? targets.filter((id) => !names.has(id)) : [];
  const selected = new Set(targets);
  const overridden = items.filter(
    ({ id, value }) => selected.has(id) && value.plugins?.['consumer-restriction'],
  );
  return (
    <div className="scope-picker">
      <Radio.Group
        aria-label={t('授权维度')}
        value={mode}
        disabled={disabled}
        onChange={({ target }) => onChange(target.value, [])}
      >
        {allowUnrestricted && (
          <Radio.Button value="none">
            <GlobalOutlined aria-hidden="true" /> {t('不额外限制')}
          </Radio.Button>
        )}
        <Radio.Button value="route_id">
          <BranchesOutlined aria-hidden="true" /> {t('指定路由')}
        </Radio.Button>
        <Radio.Button value="service_id">
          <ApartmentOutlined aria-hidden="true" /> {t('指定服务')}
        </Radio.Button>
      </Radio.Group>
      {mode === 'none' ? (
        <p className="scope-hint">{t('此处未设置白名单，访问权限由现有网关策略决定。')}</p>
      ) : (
        <>
          <label className="scope-target-label" htmlFor={targetId}>
            {mode === 'route_id' ? t('允许访问的路由') : t('允许访问的服务')}
            <small>{t('已选 {0} 项', targets.length)}</small>
          </label>
          <Select
            id={targetId}
            aria-describedby={targetId + '-hint'}
            mode="multiple"
            aria-label={mode === 'route_id' ? t('允许访问的路由') : t('允许访问的服务')}
            showSearch
            disabled={disabled}
            value={targets}
            loading={resources.isFetching}
            status={targets.length ? undefined : 'warning'}
            placeholder={
              mode === 'route_id' ? t('搜索路由名称、ID 或路径') : t('搜索服务名称、ID 或说明')
            }
            filterOption={(input, option) =>
              [option?.label, option?.detail].some((text) =>
                text?.toLowerCase().includes(input.trim().toLowerCase()),
              )
            }
            onChange={(ids) => onChange(mode, ids)}
            options={options}
            optionRender={({ data }) => (
              <div className="shared-config-option">
                <span>{data.label}</span>
                {data.detail && <small>{data.detail}</small>}
              </div>
            )}
          />
          <p id={targetId + '-hint'} className="scope-hint" aria-live="polite">
            {!targets.length && t('请至少选择一个目标。') + ' '}
            {mode === 'route_id'
              ? t('认证通过后，仅放行所选路由。')
              : t('所选服务下的路由共享授权，包括以后绑定的路由。未绑定服务的认证路由返回 401。')}
          </p>
          {resources.error && (
            <RequestError error={resources.error} retry={() => resources.refetch()} />
          )}
          {missing.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title={t('当前集群找不到已选 ID：{0}', missing.join(', '))}
            />
          )}
          {overridden.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title={t(
                '这些目标已有同名访问策略，消费者白名单将优先生效：{0}',
                overridden.map((item) => item.id).join(', '),
              )}
            />
          )}
        </>
      )}
    </div>
  );
}

export function ConsumerScope({
  policy,
  hasDecryptionKey,
  onChange,
  readOnly,
  available,
}: {
  policy?: JsonObject;
  hasDecryptionKey: boolean;
  onChange: (config?: JsonObject) => void;
  readOnly: boolean;
  available?: boolean;
}) {
  const t = useTranslate();
  const mode = scopeMode(policy);
  return (
    <Panel
      title={
        <Space>
          <SafetyOutlined aria-hidden="true" />
          {t('认证访问范围')}
        </Space>
      }
      extra={
        <Tag color={mode === 'none' ? undefined : 'blue'}>
          {mode === 'none'
            ? t('继承现有策略')
            : mode === 'advanced'
              ? t('自定义策略')
              : t('白名单')}
        </Tag>
      }
    >
      <div className="form-panel consumer-scope">
        <p className="scope-description">
          {t(
            '访问范围在网关识别出该消费者后生效，适用于其内联认证及独立凭据。请在目标路由或服务上启用相应认证。',
          )}
        </p>
        {hasDecryptionKey && (
          <Alert
            type="info"
            showIcon
            title={t('JWE 解密密钥的访问边界')}
            description={t(
              'JWE 只读取密钥解密。需要限制接口访问时，请同时启用身份认证，并对认证得到的消费者授权。',
            )}
          />
        )}
        {mode === 'advanced' ? (
          <Alert
            type="info"
            showIcon
            title={policy?._meta?.disable ? t('当前访问策略已停用') : t('当前使用高级访问策略')}
            description={t(
              '在下方插件列表中编辑 consumer-restriction，可查看黑名单、按方法授权及执行条件。',
            )}
          />
        ) : (
          <ScopePicker
            mode={mode}
            targets={policy?.whitelist || []}
            disabled={readOnly || !available}
            allowUnrestricted
            onChange={(type, ids) =>
              onChange(type === 'none' ? undefined : { ...policy, type, whitelist: ids })
            }
          />
        )}
        {available === false && (
          <p className="scope-hint">{t('访问范围需要当前集群启用 consumer-restriction。')}</p>
        )}
        {mode !== 'none' && (
          <p className="scope-precedence">
            {t(
              '消费者上的 consumer-restriction 优先于消费者组、路由和服务上的同名插件。已有访问名单时，请核对允许的目标。',
            )}
          </p>
        )}
      </div>
    </Panel>
  );
}

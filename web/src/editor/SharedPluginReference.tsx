import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Select, Space, Tag } from 'antd';
import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { Panel, RequestError } from '../components/Common';
import { PluginIcon } from '../components/PluginIcon';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import type { JsonObject, Resource } from '../types';

export function SharedPluginReference({
  value,
  onChange,
  readOnly,
}: {
  value: JsonObject;
  onChange: (id: string | undefined) => void;
  readOnly: boolean;
}) {
  const { clusterId } = useConsole();
  const t = useTranslate();
  const configs = useQuery({
    queryKey: ['resources', clusterId, 'plugin_configs'],
    queryFn: ({ signal }) =>
      api<{ items: Resource[] }>('/clusters/' + clusterId + '/resources/plugin_configs', {
        signal,
      }),
    refetchOnWindowFocus: true,
  });
  const id = value.plugin_config_id == null ? undefined : String(value.plugin_config_id);
  const items = configs.data?.items || [];
  const selected = items.find((item) => item.id === id);
  const options = items.map(({ id, value }) => ({
    value: id,
    label: value.desc ? value.desc + ' · ' + id : id,
    plugins: Object.keys(value.plugins || {}).sort(),
  }));
  const shared = selected?.value.plugins || {};
  const names = Object.keys(shared).sort();
  const params = new URLSearchParams({ cluster: clusterId, kind: 'plugin_configs' });
  if (selected) params.set('resource', selected.id);
  return (
    <Panel
      title={t('共享插件配置')}
      extra={
        <Space wrap>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            loading={configs.isFetching}
            onClick={() => configs.refetch()}
          >
            {t('刷新共享配置')}
          </Button>
          <Button
            type="link"
            href={'/policies?' + params}
            target="_blank"
            rel="noopener noreferrer"
            icon={<ExportOutlined />}
          >
            {t('管理共享配置')}
          </Button>
        </Space>
      }
    >
      <div className="form-panel shared-plugin-reference">
        <Form layout="vertical">
          <Form.Item
            label={t('引用插件配置')}
            extra={t(
              '每条路由可引用一份共享配置，继承其中的多个插件。同名插件采用路由上的完整配置。',
            )}
          >
            <Select
              aria-label={t('引用插件配置')}
              showSearch
              allowClear
              disabled={readOnly}
              value={id}
              loading={configs.isLoading}
              onChange={onChange}
              options={options}
              placeholder={t('按配置 ID、描述或插件名搜索')}
              filterOption={(input, option) =>
                [option?.label, ...(option?.plugins || [])].some((text) =>
                  text?.toLowerCase().includes(input.trim().toLowerCase()),
                )
              }
              optionRender={({ data }) => (
                <div className="shared-config-option">
                  <span>{data.label}</span>
                  <small>{data.plugins.join(' · ') || t('此配置未包含插件')}</small>
                </div>
              )}
            />
          </Form.Item>
        </Form>
        {configs.error && <RequestError error={configs.error} retry={() => configs.refetch()} />}
        {!configs.error && configs.isSuccess && id && !selected && (
          <Alert showIcon type="warning" title={t('当前集群中找不到引用的共享配置 {0}', id)} />
        )}
        {selected && (
          <div aria-live="polite">
            <h3>{t('共享配置中的插件（{0}）', names.length)}</h3>
            {names.length ? (
              <ul aria-label={t('共享配置中的插件')} className="shared-plugin-list">
                {names.map((name) => {
                  const overridden = Object.hasOwn(value.plugins || {}, name);
                  const effective = overridden ? value.plugins[name] : shared[name];
                  return (
                    <li key={name}>
                      <PluginIcon name={name} />
                      <strong>{name}</strong>
                      <Tag color={overridden ? 'gold' : 'blue'}>
                        {overridden ? t('路由覆盖') : t('继承共享配置')}
                      </Tag>
                      {effective?._meta?.disable === true && <Tag>{t('已停用')}</Tag>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="muted">{t('此配置未包含插件')}</span>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

import { languageFooter } from '../components/LanguageSwitch';
import { useFeedback } from '../i18n/feedback';
import { useLocaleForm } from '../i18n/useLocaleForm';
import { useLocale, useTranslate } from '../i18n';
import { useState } from 'react';
import { App, Alert, Button, Form, Input, Modal, Select, Space, Switch, Tag } from 'antd';
import {
  CloudServerOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../api';
import { useConsole } from '../context';
import { PageTitle, Panel, Checks, Blank } from '../components/Common';
import { displayTime, environmentNames, type Cluster, type Validation } from '../types';

export function Clusters() {
  const feedback = useFeedback();
  const t = useTranslate();
  const locale = useLocale();
  const { clusters, clusterId, go } = useConsole();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [editing, setEditing] = useState<Cluster | null | undefined>(undefined);
  const form = useLocaleForm(editing !== undefined);
  const [results, setResults] = useState<Record<string, Validation>>({});
  const probe = useMutation({
    mutationFn: (id: string) => post<Validation>(`/clusters/${id}/probe`),
    onSuccess: (result, id) => {
      setResults((previous) => ({ ...previous, [id]: result }));
      client.invalidateQueries({ queryKey: ['clusters'] });
      result.ok
        ? message.success(t('集群连接正常'))
        : message.warning(t('部分能力检测失败，请查看检测结果'));
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api<Cluster>(editing ? `/clusters/${editing.id}` : '/clusters', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(values),
      }),
    onSuccess: async (c) => {
      setEditing(undefined);
      await client.invalidateQueries({ queryKey: ['clusters'] });
      go('/clusters', c.id);
      message.success(t('集群已保存，正在检测连接'));
      probe.mutate(c.id);
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const open = (cluster: Cluster | null) => {
    form.resetFields();
    form.setFieldsValue(
      cluster ? { ...cluster, api_key: '' } : { environment: 'staging', read_only: false },
    );
    setEditing(cluster);
  };
  return (
    <>
      <PageTitle
        eyebrow={t('集群接入管理')}
        title={t('集群连接')}
        description={t('一个工作空间，管理多个环境。凭据加密保存，连接能力独立检测。')}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined aria-hidden="true" />}
            onClick={() => open(null)}
          >
            {t('接入集群')}
          </Button>
        }
      />
      <div className="info-strip">
        <SafetyCertificateOutlined aria-hidden="true" />
        <span>
          {t('Admin API 由管理后端访问。建议为控制台配置专用密钥，并限制网关管理端口的访问范围。')}
        </span>
      </div>
      {!clusters.length ? (
        <Panel>
          <Blank
            text={t('还没有接入任何集群')}
            action={
              <Button type="primary" onClick={() => open(null)}>
                {t('接入第一个集群')}
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="cluster-grid">
          {clusters.map((c) => (
            <Panel
              key={c.id}
              className={`cluster-card ${clusterId === c.id ? 'selected-cluster' : ''}`}
            >
              <div className="cluster-card-top">
                <div className="cluster-icon">
                  <CloudServerOutlined aria-hidden="true" />
                </div>
                <Space>
                  <Tag color={c.environment === 'production' ? 'orange' : 'blue'}>
                    {t(environmentNames[c.environment])}
                  </Tag>
                  {c.read_only && <Tag>{t('只读')}</Tag>}
                </Space>
              </div>
              <div className="cluster-card-title">
                <h2>{c.name}</h2>
                {clusterId === c.id && <span className="selected-label">{t('当前集群')}</span>}
              </div>
              <p className="cluster-description">{c.description || t('APISIX 管理集群')}</p>
              <div className="cluster-address mono">{c.url}</div>
              <dl className="cluster-meta">
                <div>
                  <dt>{t('连接状态')}</dt>
                  <dd>
                    <span className={`status-dot ${c.status}`} />
                    {c.status === 'connected'
                      ? t('可连接')
                      : c.status === 'error'
                        ? t('检测失败')
                        : t('尚未检测')}
                  </dd>
                </div>
                <div>
                  <dt>{t('APISIX 版本')}</dt>
                  <dd>{c.version || t('未探测')}</dd>
                </div>
                <div>
                  <dt>{t('最近检测')}</dt>
                  <dd>{displayTime(c.last_checked, locale)}</dd>
                </div>
              </dl>
              {results[c.id] && <Checks checks={results[c.id].checks} />}
              <div className="cluster-actions">
                <Button
                  icon={<LinkOutlined aria-hidden="true" />}
                  loading={probe.isPending && probe.variables === c.id}
                  onClick={() => probe.mutate(c.id)}
                >
                  {t('检测连接')}
                </Button>
                <Button icon={<EditOutlined aria-hidden="true" />} onClick={() => open(c)}>
                  {t('编辑')}
                </Button>
                <Button type="link" onClick={() => go('/routes', c.id)}>
                  {t('进入集群')}
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      )}
      <Modal
        footer={languageFooter}
        title={editing ? t('编辑集群连接') : t('接入 APISIX 集群')}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText={t('保存并检测')}
        cancelText={t('取消')}
        width={580}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save.mutate}>
          <div className="form-two">
            <Form.Item
              name="name"
              label={t('集群名称')}
              rules={[{ required: true, message: t('请输入集群名称') }]}
            >
              <Input placeholder={t('例如：测试网关')} maxLength={100} />
            </Form.Item>
            <Form.Item name="environment" label={t('所属环境')} rules={[{ required: true }]}>
              <Select
                disabled={!!editing}
                options={Object.entries(environmentNames).map(([value, label]) => ({
                  value,
                  label: t(label),
                }))}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="url"
            label={t('Admin API 地址')}
            extra={t('填写管理后端可访问的地址。地址与环境保存后固定，更换目标请新建连接。')}
            rules={[
              { required: true, message: t('请输入 Admin API 地址') },
              { type: 'url', message: t('请输入完整的 HTTP 或 HTTPS 地址') },
            ]}
          >
            <Input disabled={!!editing} placeholder="http://apisix:9180" />
          </Form.Item>
          <Form.Item
            name="api_key"
            label="Admin API Key"
            rules={[{ required: !editing, message: t('请输入管理密钥') }]}
            extra={
              editing
                ? t('留空保留原有密钥；原值不会回显。')
                : t('密钥仅保存在服务端，用于管理网关。')
            }
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={editing ? t('留空保留现有密钥') : t('请输入专用管理密钥')}
            />
          </Form.Item>
          <Form.Item name="description" label={t('说明')}>
            <Input.TextArea
              rows={2}
              maxLength={300}
              placeholder={t('集群用途、负责人或网络说明')}
            />
          </Form.Item>
          <Form.Item name="read_only" label={t('只读接入')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Alert type="info" showIcon title={t('连接检测只读取资源和插件信息，不修改网关配置。')} />
        </Form>
      </Modal>
    </>
  );
}

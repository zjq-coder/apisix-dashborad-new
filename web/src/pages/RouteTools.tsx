import { useConfigWrite } from '../useConfigWrite';
import { useRef, useState } from 'react';
import { Alert, Button, Dropdown, Form, Input, Modal, Radio, Select, Space } from 'antd';
import {
  CodeOutlined,
  DownOutlined,
  DownloadOutlined,
  ImportOutlined,
  BlockOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useConsole } from '../context';
import { useTranslate } from '../i18n';
import { languageFooter } from '../components/LanguageSwitch';
import { api } from '../api';
import { RequestError } from '../components/Common';
import type { Resource } from '../types';
import { exportOpenAPI, importOpenAPI, maxFileSize } from '../routeOpenAPI';

export function RouteTools({ selected }: { selected: Resource[] }) {
  const { cluster, can, go } = useConsole();
  const t = useTranslate();
  const direct = useConfigWrite();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<Resource[]>([]);
  const deletion = useMutation({
    mutationFn: () =>
      direct.write(
        {
          routes: removing.map((r) => ({ id: r.id, base_hash: r.hash })),
        },
        'routes/batch-delete',
      ),
    onSuccess: () => setRemoving([]),
  });
  const [format, setFormat] = useState('json');
  const writable = !cluster?.read_only && can('edit');
  function download() {
    const content = exportOpenAPI(selected, cluster!.name, format);
    const url = URL.createObjectURL(
      new Blob([content], { type: format === 'yaml' ? 'application/yaml' : 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'apisix-routes.' + format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setOpen(false);
  }
  return (
    <Space wrap size={4}>
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              key: 'policies',
              label: t('插件模板配置'),
              icon: <BlockOutlined aria-hidden="true" />,
              onClick: () => go('/policies?kind=plugin_configs'),
            },
            {
              key: 'raw',
              label: t('数据编辑器'),
              icon: <CodeOutlined aria-hidden="true" />,
              disabled: !writable,
              onClick: () => go('/routes/new?mode=json'),
            },
            {
              key: 'import',
              label: t('导入 OpenAPI'),
              icon: <ImportOutlined aria-hidden="true" />,
              disabled: !writable,
              onClick: () => go('/routes/import'),
            },
          ],
        }}
      >
        <Button>
          {t('高级特性')} <DownOutlined aria-hidden="true" />
        </Button>
      </Dropdown>
      <Button
        icon={<DownloadOutlined aria-hidden="true" />}
        disabled={!selected.length}
        onClick={() => setOpen(true)}
      >
        {t('导出 OpenAPI')}
        {selected.length ? ' (' + selected.length + ')' : ''}
      </Button>
      {selected.length > 0 && (
        <Button
          danger
          disabled={!writable || selected.length > 50}
          onClick={() => {
            deletion.reset();
            setRemoving(selected);
          }}
        >
          {t('批量删除')}
        </Button>
      )}
      <Modal
        open={!!removing.length}
        title={t('删除选中的 {0} 条路由？', removing.length)}
        footer={languageFooter}
        confirmLoading={deletion.isPending}
        okButtonProps={{ danger: true, disabled: !direct.ready || deletion.isError }}
        cancelButtonProps={{ disabled: deletion.isPending, autoInsertSpace: false }}
        onCancel={() => {
          if (!deletion.isPending) setRemoving([]);
        }}
        onOk={() => deletion.mutate()}
        okText={direct.publish ? t('确认删除') : direct.label}
        cancelText={t('取消')}
      >
        <p>{t('发布后，网关将从「{0}」删除以下路由。', cluster?.name || '')}</p>
        {direct.confirmationField}
        <ul>
          {removing.map((r) => (
            <li key={r.id}>
              {r.value.name || r.id} · {r.id}
            </li>
          ))}
        </ul>
        {deletion.error && <RequestError error={deletion.error} />}
      </Modal>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        onOk={download}
        okText={t('下载')}
        cancelText={t('取消')}
        footer={languageFooter}
        cancelButtonProps={{ autoInsertSpace: false }}
        okButtonProps={{ disabled: !selected.length, autoInsertSpace: false }}
        title={t('导出 OpenAPI')}
      >
        <p>{t('导出当前选中的 {0} 条路由，配置中的敏感值已隐藏。', selected.length)}</p>
        <Radio.Group
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          options={['json', 'yaml'].map((value) => ({ value, label: value.toUpperCase() }))}
        />
      </Modal>
    </Space>
  );
}

export function RouteImportFields({
  setBundle,
  busy,
}: {
  setBundle: (value: string) => void;
  busy: boolean;
}) {
  const { clusterId } = useConsole();
  const t = useTranslate();
  const [source, setSource] = useState(''),
    [upstream, setUpstream] = useState(''),
    [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const list = useQuery({
    queryKey: ['resources', clusterId, 'upstreams'],
    queryFn: () => api<{ items: Resource[] }>('/clusters/' + clusterId + '/resources/upstreams'),
  });
  function reset() {
    setError('');
    setBundle('');
  }
  return (
    <Form layout="vertical">
      <p>
        {t(
          '标准操作按路径与方法转换为停用路由，请在启用前核对认证、参数和上游。含 x-apisix-routes 的文件按扩展中的完整配置恢复。',
        )}
      </p>
      <Space wrap>
        <Button onClick={() => file.current?.click()} disabled={busy || reading}>
          {t('选择 JSON 或 YAML 文件')}
        </Button>
        <input
          ref={file}
          type="file"
          hidden
          accept=".json,.yaml,.yml"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            reset();
            setSource('');
            setReading(true);
            try {
              if (f.size > maxFileSize) throw Error('文件超过 2 MiB');
              setSource(await f.text());
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setReading(false);
            }
          }}
        />
      </Space>
      <Form.Item label={t('OpenAPI 文档')}>
        <Input.TextArea
          aria-label={t('OpenAPI 文档')}
          rows={7}
          value={source}
          disabled={busy || reading}
          onChange={(e) => {
            reset();
            setSource(e.target.value);
          }}
        />
      </Form.Item>
      <Form.Item label={t('默认上游')}>
        <Select
          aria-label={t('默认上游')}
          allowClear
          showSearch
          optionFilterProp="label"
          value={upstream || undefined}
          disabled={busy || reading}
          onChange={(v) => {
            reset();
            setUpstream(v || '');
          }}
          options={list.data?.items.map((r) => ({
            value: r.id,
            label: (r.value.name || r.id) + ' · ' + r.id,
          }))}
        />
      </Form.Item>
      {list.error && <RequestError error={list.error} retry={() => list.refetch()} />}
      {error && <Alert showIcon type="error" title={t(error)} />}
      <Button
        disabled={!source.trim() || busy || reading}
        onClick={() => {
          reset();
          try {
            setBundle(
              JSON.stringify(
                { format: 'apisix-dashboard/v1', items: importOpenAPI(source, upstream) },
                null,
                2,
              ),
            );
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        {t('解析路由')}
      </Button>
    </Form>
  );
}

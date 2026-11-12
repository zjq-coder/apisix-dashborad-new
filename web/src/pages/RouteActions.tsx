import { useConfigWrite } from '../useConfigWrite';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Drawer, Modal, Space, Tag } from 'antd';
import { api } from '../api';
import { cleanConfig } from '../config';
import { useConsole } from '../context';
import { Loading, RequestError } from '../components/Common';
import { ConfigPreview } from '../components/ConfigPreview';
import { languageFooter } from '../components/LanguageSwitch';
import { useTranslate } from '../i18n';
import { useFeedback } from '../i18n/feedback';
import { pretty, type Resource } from '../types';

export type RouteAction = { type: 'view' | 'status' | 'delete'; route: Resource; kind?: string };

export function RouteActionDialog({ action, close }: { action: RouteAction; close: () => void }) {
  const { clusterId, cluster } = useConsole();
  const t = useTranslate();
  const feedback = useFeedback();
  const direct = useConfigWrite();
  const kind = action.kind || 'routes';
  const { route, type } = action;
  const name = route.value.name || route.id;
  const online = route.value.status !== 0;
  const label = type === 'delete' ? t('删除') : online ? t('下线') : t('发布');
  const live = useQuery({
    queryKey: ['resource', clusterId, 'routes', route.id],
    queryFn: ({ signal }) =>
      api<Resource>(
        '/clusters/' + clusterId + '/resources/routes/' + encodeURIComponent(route.id),
        { signal },
      ),
    enabled: type === 'view',
    refetchOnMount: 'always',
  });
  const save = useMutation({
    mutationFn: () =>
      direct.write({
        cluster_id: clusterId,
        resource_type: kind,
        resource_id: route.id,
        action: type === 'delete' ? 'delete' : 'update',
        base_hash: route.hash,
        title: t('{0} · {1}', label, name).slice(0, 60),
        value: type === 'delete' ? null : { ...cleanConfig(route.value), status: online ? 0 : 1 },
      }),
    onSuccess: close,
  });
  if (type === 'view')
    return (
      <Drawer open title={t('查看网关路由')} onClose={close} width="min(720px, 100vw)">
        {live.isError ? (
          <RequestError error={live.error} retry={() => live.refetch()} />
        ) : !live.data || live.isFetching ? (
          <Loading />
        ) : (
          <>
            <h2>{live.data.value.name || route.id}</h2>
            <Space wrap>
              <Tag>{cluster?.name}</Tag>
              <Tag>{route.id}</Tag>
              <Tag color={live.data.value.status === 0 ? 'default' : 'green'}>
                {t(live.data.value.status === 0 ? '已停用' : '已启用')}
              </Tag>
            </Space>
            <p className="muted">{t('当前网关配置，敏感值已隐藏。')}</p>
            <ConfigPreview value={pretty(live.data.value)} />
          </>
        )}
      </Drawer>
    );
  return (
    <Modal
      open
      title={t('{0}「{1}」？', label, name)}
      footer={languageFooter}
      onCancel={close}
      cancelText={t('取消')}
      okText={direct.publish ? t('确认{0}', label) : direct.label}
      confirmLoading={save.isPending}
      closable={!save.isPending}
      maskClosable={!save.isPending}
      keyboard={!save.isPending}
      cancelButtonProps={{ disabled: save.isPending, autoInsertSpace: false }}
      okButtonProps={{
        danger: type === 'delete' || online,
        disabled: !direct.ready || save.isError,
      }}
      onOk={() => save.mutate()}
    >
      <Space wrap>
        <Tag>{cluster?.name}</Tag>
        <Tag>{route.id}</Tag>
      </Space>
      <p>
        {type === 'delete'
          ? t('发布后，网关将删除此资源。')
          : online
            ? t('发布后，网关将停止匹配这条路由。')
            : t('发布后，网关将开始匹配这条路由。')}
      </p>
      {direct.confirmationField}
      {save.isError && (
        <Alert
          type="error"
          showIcon
          title={feedback(save.error.message)}
          description={t('关闭窗口并刷新列表后重试。')}
        />
      )}
    </Modal>
  );
}

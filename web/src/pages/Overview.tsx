import {
  ApartmentOutlined,
  ArrowRightOutlined,
  BlockOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  DiffOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LockOutlined,
  PlusOutlined,
  RocketOutlined,
  RollbackOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Skeleton, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { NoCluster, PageTitle, Panel, RequestError, StatusTag } from '../components/Common';
import { useConsole } from '../context';
import { useLocale, useTranslate } from '../i18n';
import { useFeedback } from '../i18n/feedback';
import { actionNames, displayTime, kindNames, type Change, type Draft } from '../types';
import './workspace.css';

type Workspace = {
  drafts: Pick<Draft, 'id' | 'title' | 'resource_type' | 'resource_id' | 'action' | 'updated_at'>[];
  changes: Pick<Change, 'id' | 'title' | 'status' | 'rollback_of' | 'created_by' | 'created_at'>[];
};

const resources = [
  { path: 'routes', title: '路由管理', detail: '路径匹配、转发与插件', icon: BranchesOutlined },
  {
    path: 'upstreams',
    title: '上游管理',
    detail: '节点权重与负载均衡',
    icon: ApartmentOutlined,
  },
  {
    path: 'consumers',
    title: '消费者管理',
    detail: '身份、凭据与访问策略',
    icon: UserOutlined,
  },
  { path: 'plugins', title: '插件目录', detail: '已启用插件与配置结构', icon: BlockOutlined },
] as const;

export function Overview() {
  const t = useTranslate();
  const locale = useLocale();
  const feedback = useFeedback();
  const { cluster, clusterId, go, can } = useConsole();
  const workspace = useQuery({
    queryKey: ['workspace', clusterId],
    queryFn: ({ signal }) => api<Workspace>(`/clusters/${clusterId}/workspace`, { signal }),
    enabled: !!clusterId,
    staleTime: 0,
  });
  if (!cluster) return <NoCluster />;
  const search = '?cluster=' + encodeURIComponent(clusterId);
  const data = workspace.data;

  return (
    <div className="config-workspace">
      <PageTitle
        title={t('配置工作台')}
        description={t('管理「{0}」的路由与服务配置，在发布前审查变更。', cluster.name)}
        extra={
          <>
            {!cluster.read_only && !can('edit') && (
              <Tag icon={<LockOutlined />}>{t('只读权限')}</Tag>
            )}
            {cluster.read_only && <Tag icon={<LockOutlined />}>{t('只读接入')}</Tag>}
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={cluster.read_only || !can('edit')}
              onClick={() => go('/routes/new')}
            >
              {t('新建路由')}
            </Button>
          </>
        }
      />
      <nav className="workspace-shortcuts" aria-label={t('配置入口')}>
        {resources.map(({ path, title, detail, icon: Icon }) => (
          <Link
            key={path}
            to={'/' + path + search}
            className={'workspace-shortcut shortcut-' + path}
          >
            <span className="shortcut-icon">
              <Icon aria-hidden="true" />
            </span>
            <ArrowRightOutlined aria-hidden="true" className="shortcut-arrow" />
            <strong>{t(title)}</strong>
            <span className="shortcut-detail">{t(detail)}</span>
          </Link>
        ))}
      </nav>
      {workspace.isError ? (
        <RequestError error={workspace.error} retry={() => void workspace.refetch()} />
      ) : (
        <div className="workspace-panels">
          <Panel
            title={
              <>
                <DiffOutlined aria-hidden="true" />
                {t('待审草稿')}
              </>
            }
            extra={
              <Link className="workspace-link" to={'/drafts' + search}>
                {t('打开草稿箱')} <ArrowRightOutlined aria-hidden="true" />
              </Link>
            }
          >
            {!data ? (
              <Skeleton active className="workspace-skeleton" />
            ) : data.drafts.length ? (
              <ul className="workspace-list">
                {data.drafts.map((draft) => (
                  <li key={draft.id}>
                    <Link
                      className="workspace-row"
                      to={'/drafts' + search + '&preview=' + encodeURIComponent(draft.id)}
                    >
                      <span className="workspace-row-icon">
                        <FileTextOutlined aria-hidden="true" />
                      </span>
                      <span className="workspace-row-text">
                        <strong title={draft.title}>{draft.title}</strong>
                        <small>
                          {t(actionNames[draft.action])} · {t(kindNames[draft.resource_type])} /{' '}
                          {draft.resource_id}
                        </small>
                      </span>
                      <time dateTime={draft.updated_at}>
                        {displayTime(draft.updated_at, locale)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="workspace-empty">
                <CheckCircleOutlined aria-hidden="true" />
                <strong>{t('暂无待审草稿')}</strong>
                <p>{t('保存配置草稿后，可在这里打开差异预览。')}</p>
              </div>
            )}
          </Panel>
          <Panel
            title={
              <>
                <HistoryOutlined aria-hidden="true" />
                {t('最近变更')}
              </>
            }
            extra={
              <Link className="workspace-link" to={'/changes' + search}>
                {t('发布记录')} <ArrowRightOutlined aria-hidden="true" />
              </Link>
            }
          >
            {!data ? (
              <Skeleton active className="workspace-skeleton" />
            ) : data.changes.length ? (
              <ul className="workspace-list">
                {data.changes.map((change) => (
                  <li key={change.id}>
                    <Link
                      className="workspace-row"
                      to={'/changes/' + encodeURIComponent(change.id) + search}
                    >
                      <span className="workspace-row-icon">
                        {change.rollback_of ? (
                          <RollbackOutlined aria-hidden="true" />
                        ) : (
                          <RocketOutlined aria-hidden="true" />
                        )}
                      </span>
                      <span className="workspace-row-text">
                        <strong title={change.rollback_of ? feedback(change.title) : change.title}>
                          {change.rollback_of ? feedback(change.title) : change.title}
                        </strong>
                        <small>
                          {change.created_by} ·{' '}
                          <time dateTime={change.created_at}>
                            {displayTime(change.created_at, locale)}
                          </time>
                        </small>
                      </span>
                      <StatusTag status={change.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="workspace-empty">
                <HistoryOutlined aria-hidden="true" />
                <strong>{t('暂无发布记录')}</strong>
                <p>{t('从草稿创建变更后，可在这里查看发布详情。')}</p>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

import { useFeedback } from '../i18n/feedback';
import { useTranslate } from '../i18n';
import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton, Space, Tag } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  CloudServerOutlined,
} from '@ant-design/icons';
import { useConsole } from '../context';
import { statusNames, type Check } from '../types';

export function PageTitle({
  title,
  description,
  extra,
  eyebrow,
}: {
  title: string;
  description?: string;
  extra?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  );
}
export function Panel({
  title,
  extra,
  children,
  className = '',
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-heading">
          <h2>{title}</h2>
          {extra}
        </header>
      )}
      {children}
    </section>
  );
}
export function StatusTag({ status }: { status: string }) {
  const t = useTranslate();
  const colors: Record<string, string> = {
    succeeded: 'success',
    published: 'success',
    applied: 'success',
    publishing: 'processing',
    applying: 'processing',
    pending: 'blue',
    failed: 'error',
    conflict: 'orange',
    unknown: 'orange',
    draft: 'gold',
    submitted: 'purple',
  };
  return (
    <Tag
      color={colors[status]}
      icon={
        status === 'publishing' || status === 'applying' ? (
          <LoadingOutlined aria-hidden="true" />
        ) : undefined
      }
    >
      {t(statusNames[status]) || status}
    </Tag>
  );
}
export function RequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  const feedback = useFeedback();
  const t = useTranslate();
  return (
    <Alert
      type="error"
      showIcon
      title={t('加载失败')}
      description={feedback(error instanceof Error ? error.message : String(error))}
      action={
        retry && (
          <Button aria-label={t('重试')} onClick={retry}>
            {t('重试')}
          </Button>
        )
      }
    />
  );
}
export function Loading() {
  return (
    <div className="loading-panel">
      <Skeleton active paragraph={{ rows: 6 }} />
    </div>
  );
}
export function NoCluster() {
  const t = useTranslate();
  const { go, isAdmin } = useConsole();
  if (!isAdmin)
    return (
      <div className="onboarding-empty">
        <CloudServerOutlined className="empty-symbol" />
        <h2>{t('尚未分配集群')}</h2>
        <p>{t('请联系管理员，为你的账号分配集群访问权限。')}</p>
      </div>
    );
  return (
    <div className="onboarding-empty">
      <CloudServerOutlined aria-hidden="true" className="empty-symbol" />
      <h2>{t('从接入第一个集群开始')}</h2>
      <p>{t('连接 APISIX Admin API，集中管理路由、上游与每一次配置变更。')}</p>
      <Button type="primary" size="large" onClick={() => go('/clusters')}>
        {t('接入集群')}
      </Button>
      <div className="empty-steps">
        <span>{t('01 · 建立连接')}</span>
        <span>{t('02 · 编辑配置')}</span>
        <span>{t('03 · 审查并发布')}</span>
      </div>
    </div>
  );
}
export function Blank({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text}>
      {action}
    </Empty>
  );
}
export function Checks({ checks }: { checks: Check[] }) {
  const feedback = useFeedback();
  return (
    <div className="checks">
      {checks.map((check, index) => (
        <div className={`check-row ${check.ok ? 'pass' : 'fail'}`} key={`${index}-${check.name}`}>
          {check.ok ? (
            <CheckCircleOutlined aria-hidden="true" />
          ) : (
            <CloseCircleOutlined aria-hidden="true" />
          )}
          <div>
            <strong>{feedback(check.name)}</strong>
            <p>{feedback(check.message)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

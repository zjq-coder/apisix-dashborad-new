import { useTranslate } from '../i18n';
import { lazy, Suspense, useState } from 'react';
import { Alert, Empty, Segmented, Spin, Table, Tag } from 'antd';
import { pretty, type Difference, type JsonObject } from '../types';
const JSONDiff = lazy(() =>
  import('./CodeEditor').then((module) => ({ default: module.JSONDiff })),
);
export function DiffView({
  before,
  after,
  diff,
}: {
  before: JsonObject | null;
  after: JsonObject | null;
  diff: Difference[];
}) {
  const t = useTranslate();
  const [mode, setMode] = useState('fields');
  const format = (value: unknown) =>
    value === null || value === undefined ? (
      <span className="muted">{t('未配置')}</span>
    ) : (
      <code className="diff-cell">{typeof value === 'string' ? value : JSON.stringify(value)}</code>
    );
  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span>
          <strong>{diff.length}</strong> {t('项字段变更')}
        </span>
        <Segmented
          value={mode}
          onChange={(v) => setMode(String(v))}
          options={[
            { value: 'fields', label: t('字段差异') },
            { value: 'json', label: t('JSON 差异') },
          ]}
        />
      </div>
      {mode === 'fields' ? (
        <Table<Difference>
          rowKey="path"
          dataSource={diff}
          pagination={false}
          size="small"
          scroll={{ x: 600 }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('没有字段变化')} />
            ),
          }}
          columns={[
            {
              title: t('字段'),
              dataIndex: 'path',
              width: '34%',
              render: (path: string, item) => (
                <div className="diff-path">
                  <Tag
                    color={item.kind === 'add' ? 'green' : item.kind === 'remove' ? 'red' : 'blue'}
                  >
                    {item.kind === 'add' ? '+' : item.kind === 'remove' ? '−' : '~'}
                  </Tag>
                  <code>{path || '/'}</code>
                </div>
              ),
            },
            { title: t('当前值 / 发布前'), dataIndex: 'before', width: '33%', render: format },
            {
              title: t('目标值 / 发布后'),
              dataIndex: 'after',
              width: '33%',
              render: (value, row) => (
                <div className="diff-after">
                  {format(
                    row.sensitive && value === '••••••（已更新）' ? t('••••••（已更新）') : value,
                  )}
                </div>
              ),
            },
          ]}
        />
      ) : (
        <Suspense fallback={<Spin />}>
          <JSONDiff before={pretty(before || {})} after={pretty(after || {})} />
        </Suspense>
      )}
      {diff.some((d) => d.sensitive) && (
        <Alert type="info" showIcon title={t('敏感字段仅显示变更状态，实际内容已隐藏。')} />
      )}
    </div>
  );
}

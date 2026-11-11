import { LanguageSwitch } from '../components/LanguageSwitch';
import { useLocale, useTranslate } from '../i18n';
import { lazy, Suspense, useState } from 'react';
import { Button, Drawer, Input, Pagination, Select, Space, Spin, Tag } from 'antd';
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  ExportOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useConsole } from '../context';
import { Blank, Loading, NoCluster, PageTitle, Panel, RequestError } from '../components/Common';
import { PluginIcon } from '../components/PluginIcon';
import {
  catalogEntries,
  extensionCategory,
  hubGroups,
  officialUrl,
  hubUrl,
  matchesPlugin,
} from '../pluginHub';
import { pretty, type JsonObject } from '../types';

const CodeEditor = lazy(() => import('../components/CodeEditor'));
const categories = [...hubGroups, { name: extensionCategory, color: '#64748b' }];

export function PluginCatalog() {
  const t = useTranslate();
  const locale = useLocale();
  const { clusterId, go } = useConsole();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const query = useQuery({
    queryKey: ['plugins', clusterId],
    queryFn: () => api<string[]>(`/clusters/${clusterId}/plugins`),
    enabled: !!clusterId,
  });
  const entries = catalogEntries(query.isSuccess ? query.data || [] : []);
  const matching = entries.filter((item) => matchesPlugin(item, search));
  const counts = new Map<string, number>();
  for (const item of matching) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  const groups = categories.filter(
    (g) => g.name !== extensionCategory || entries.some((p) => p.category === extensionCategory),
  );
  const activeCategory = groups.some((group) => group.name === category) ? category : '';
  const visible = matching.filter((item) => !activeCategory || item.category === activeCategory);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visible.length / pageSize)));
  const items = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const detail = entries.find((entry) => entry.name === selected);
  const schemaName = detail?.name || '';
  const schema = useQuery({
    queryKey: ['plugin-schema', clusterId, schemaName, 'route'],
    queryFn: () =>
      api<JsonObject>(
        `/clusters/${clusterId}/plugins/${encodeURIComponent(schemaName)}/schema?scope=route`,
      ),
    enabled: !!schemaName && !!clusterId,
  });
  const chooseCategory = (name: string) => {
    setCategory(name);
    setPage(1);
  };
  const categoryOptions = [
    { name: '', label: t('全部分类'), color: '', count: matching.length },
    ...groups.map((group) => ({
      ...group,
      label: t(group.name),
      count: counts.get(group.name) || 0,
    })),
  ];
  const heading = (
    <PageTitle
      title={t('插件目录')}
      description={t('按 APISIX 官方分类查找插件，查看当前集群的配置结构。')}
      extra={
        <>
          <Button
            href={officialUrl(hubUrl, locale)}
            target="_blank"
            rel="noreferrer"
            icon={<ExportOutlined />}
          >
            {t('访问官网')}
          </Button>
          {clusterId && (
            <Button
              icon={<ReloadOutlined />}
              loading={query.isFetching}
              onClick={() => query.refetch()}
            >
              {t('刷新插件')}
            </Button>
          )}
        </>
      }
    />
  );
  if (!clusterId)
    return (
      <>
        {heading}
        <NoCluster />
      </>
    );
  return (
    <>
      {heading}
      <div className="catalog-toolbar">
        <div className="catalog-result-count" role="status">
          {query.isSuccess ? t('当前集群 · {0} 个插件', visible.length) : t('当前集群')}
        </div>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('搜索插件名称、分类或用途')}
          aria-label={t('搜索插件')}
          value={search}
          allowClear
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="catalog-mobile-categories"
          aria-label={t('筛选插件分类')}
          value={activeCategory}
          onChange={chooseCategory}
          options={categoryOptions.map(({ name, label, count }) => ({
            value: name,
            label: `${label} (${count})`,
          }))}
        />
      </div>
      <div className="catalog-layout">
        <nav className="catalog-nav" aria-label={t('插件分类')}>
          <h2>{t('插件分类')}</h2>
          {categoryOptions.map(({ name, label, count, color }) => (
            <button
              type="button"
              key={name}
              aria-pressed={activeCategory === name}
              onClick={() => chooseCategory(name)}
            >
              {name ? (
                <i className="category-dot" style={{ backgroundColor: color }} />
              ) : (
                <AppstoreOutlined />
              )}
              <span>{label}</span>
              <small>{count}</small>
            </button>
          ))}
        </nav>
        <div className="catalog-results">
          {query.isError ? (
            <RequestError error={query.error} retry={() => query.refetch()} />
          ) : query.isLoading ? (
            <Loading />
          ) : !visible.length ? (
            <Panel className="catalog-empty">
              <Blank
                text={
                  !entries.length
                    ? t('当前集群未启用插件')
                    : search
                      ? t('没有找到匹配的插件')
                      : t('当前分类没有已启用的插件')
                }
                action={
                  entries.length > 0 && (
                    <Button
                      onClick={() => {
                        setSearch('');
                        chooseCategory('');
                      }}
                    >
                      {t('重置筛选')}
                    </Button>
                  )
                }
              />
            </Panel>
          ) : (
            <>
              {groups.map((group) => {
                const cards = items.filter((item) => item.category === group.name);
                if (!cards.length) return null;
                return (
                  <section className="catalog-group" key={group.name} aria-label={t(group.name)}>
                    <header>
                      <i className="category-dot" style={{ backgroundColor: group.color }} />
                      <h2>{t(group.name)}</h2>
                      {group.name === extensionCategory && <small>{t('官网目录尚未收录')}</small>}
                    </header>
                    <div className="catalog-grid">
                      {cards.map((item) => (
                        <button
                          className="catalog-card"
                          key={item.name}
                          type="button"
                          aria-label={t('查看插件 {0}', item.name)}
                          onClick={() => setSelected(item.name)}
                        >
                          <span className="catalog-card-heading">
                            <PluginIcon name={item.name} />
                            <strong>{item.name}</strong>
                          </span>
                          <span className="catalog-card-description">{t(item.description)}</span>
                          <span className="catalog-link">
                            {t('查看配置结构')} <ArrowRightOutlined />
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
              <Pagination
                className="catalog-pagination"
                responsive
                showLessItems
                current={currentPage}
                pageSize={pageSize}
                total={visible.length}
                showSizeChanger
                pageSizeOptions={[12, 24, 48]}
                showTotal={(total) => t('共 {0} 个插件', total)}
                onChange={(nextPage, nextSize) => {
                  setPage(nextSize === pageSize ? nextPage : 1);
                  setPageSize(nextSize);
                  window.scrollTo({ top: 0, behavior: 'instant' });
                }}
              />
            </>
          )}
        </div>
      </div>
      <Drawer
        extra={<LanguageSwitch compact />}
        title={detail?.name}
        open={!!detail}
        size="min(700px, 100vw)"
        onClose={() => setSelected('')}
        destroyOnHidden
      >
        {detail && (
          <>
            <div className="catalog-detail-heading">
              <PluginIcon name={detail.name} />
              <div>
                <Space wrap>
                  <Tag>{t(detail.category)}</Tag>
                  <Tag color="green">{t('集群可用')}</Tag>
                </Space>
                <p>{t(detail.description)}</p>
              </div>
            </div>
            <Space className="catalog-detail-actions" wrap>
              {detail.docs && (
                <Button
                  href={officialUrl(detail.docs, locale)}
                  target="_blank"
                  rel="noreferrer"
                  icon={<ExportOutlined />}
                >
                  {t('官方插件文档')}
                </Button>
              )}
              <Button onClick={() => go('/routes')}>{t('前往路由管理')}</Button>
            </Space>
            <div className="catalog-schema-heading">
              <h3>{t('配置结构')}</h3>
            </div>
            {schema.isError ? (
              <RequestError error={schema.error} retry={() => schema.refetch()} />
            ) : schema.isLoading ? (
              <Spin />
            ) : (
              <Suspense fallback={<Spin />}>
                <CodeEditor
                  value={pretty(schema.data || {})}
                  height={510}
                  readOnly
                  label={t('插件 Schema')}
                />
              </Suspense>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

import { useConfigWrite } from '../useConfigWrite';
import { messageText } from '../i18n/Message';
import { LanguageSwitch, languageFooter } from '../components/LanguageSwitch';
import { useFeedback } from '../i18n/feedback';
import { useLocaleForm } from '../i18n/useLocaleForm';
import { useLocale, useTranslate } from '../i18n';
import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Timeline,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileDoneOutlined,
  HistoryOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, post } from '../api';
import { useConsole } from '../context';
import {
  Blank,
  Checks,
  Loading,
  NoCluster,
  PageTitle,
  Panel,
  RequestError,
  StatusTag,
} from '../components/Common';
import { DiffView } from '../components/DiffView';
import {
  actionNames,
  displayTime,
  environmentNames,
  kindNames,
  type Change,
  type Draft,
  type Validation,
} from '../types';

export function Drafts() {
  const feedback = useFeedback();
  const t = useTranslate();
  const locale = useLocale();
  const { cluster, clusterId, go, can } = useConsole();
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [params, setParams] = useSearchParams();
  const [selection, setSelection] = useState<React.Key[]>([]);
  const [preview, setPreview] = useState<Draft>();
  const [filter, setFilter] = useState('draft');
  const [creating, setCreating] = useState(false);
  const form = useLocaleForm(creating);
  const [validation, setValidation] = useState<Validation>();
  const query = useQuery({
    queryKey: ['drafts', clusterId],
    queryFn: () => api<Draft[]>(`/drafts?cluster_id=${clusterId}`),
    enabled: !!clusterId,
  });
  const previewId = params.get('preview');
  const listedDraft = previewId ? query.data?.find((d) => d.id === previewId) : undefined;
  // An active draft can be older than the history window returned by the list.
  const detail = useQuery({
    queryKey: ['draft', previewId],
    queryFn: ({ signal }) => api<Draft>(`/drafts/${encodeURIComponent(previewId!)}`, { signal }),
    enabled: !!previewId && query.isSuccess && !listedDraft,
  });
  const linkedDraft = listedDraft ?? detail.data;
  useEffect(() => {
    if (previewId) {
      setPreview(linkedDraft?.cluster_id === clusterId ? linkedDraft : undefined);
      setValidation(undefined);
    }
  }, [clusterId, previewId, linkedDraft]);
  const closePreview = () => {
    setPreview(undefined);
    if (previewId) {
      const next = new URLSearchParams(params);
      next.delete('preview');
      setParams(next, { replace: true });
    }
  };
  const direct = useConfigWrite();
  const applyDraft = useMutation({
    mutationFn: (d: Draft) =>
      direct.write({
        resource_type: d.resource_type,
        resource_id: d.resource_id,
        action: d.action,
        draft_id: d.id,
        revision: d.revision,
        base_hash: d.base_hash,
        title: d.title,
        value: d.after,
      }),
    onSuccess: (result) => {
      if (result.status === 'succeeded') closePreview();
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  const validate = useMutation({
    mutationFn: (id: string) => post<Validation>(`/drafts/${id}/validate`),
    onSuccess: (result) => setValidation(result),
    onError: (error) => message.error(feedback(error.message)),
  });
  const create = useMutation({
    mutationFn: (values: { title: string; reason: string }) =>
      post<Change>('/changesets', { ...values, draft_ids: selection }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ['drafts'] });
      client.invalidateQueries({ queryKey: ['changes'] });
      go(`/changes/${result.id}`);
    },
    onError: (error) => message.error(feedback(error.message)),
  });
  if (!cluster) return <NoCluster />;
  const discard = (draft: Draft) =>
    modal.confirm({
      footer: languageFooter,
      title: messageText('丢弃草稿“{0}”？', draft.title),
      content: messageText('草稿将标记为已丢弃，网关配置不会变化。'),
      okText: messageText('丢弃草稿'),
      cancelText: messageText('取消'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api(`/drafts/${draft.id}`, { method: 'DELETE' });
          await client.invalidateQueries({ queryKey: ['drafts'] });
          setSelection((keys) => keys.filter((key) => key !== draft.id));
          message.success(t('草稿已丢弃'));
        } catch (error) {
          message.error(feedback((error as Error).message));
          throw error;
        }
      },
    });
  const items = (query.data || []).filter((d) => filter === 'all' || d.status === filter);
  return (
    <>
      <PageTitle
        eyebrow={t('草稿工作空间')}
        title={t('草稿箱')}
        description={t('把修改放在一起审查。草稿保存后，网关继续使用已发布的配置。')}
        extra={
          <>
            <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={() => query.refetch()}>
              {t('刷新')}
            </Button>
            <Button
              type="primary"
              icon={<RocketOutlined aria-hidden="true" />}
              disabled={!selection.length || cluster.read_only || !can('edit')}
              onClick={() => {
                form.resetFields();
                form.setFieldsValue({ title: t('发布 {0} 项配置变更', selection.length) });
                setCreating(true);
              }}
            >
              {t('创建发布变更')}
              {selection.length ? ` (${selection.length})` : ''}
            </Button>
          </>
        }
      />
      {previewId && !listedDraft && detail.isError && (
        <RequestError error={detail.error} retry={() => void detail.refetch()} />
      )}
      {query.isError ? (
        <RequestError error={query.error} />
      ) : (
        <Panel>
          <div className="table-toolbar">
            <Select
              aria-label={t('草稿状态')}
              value={filter}
              onChange={(v) => {
                setFilter(v);
                setSelection([]);
              }}
              options={[
                { value: 'draft', label: t('待提交草稿') },
                { value: 'submitted', label: t('已提交') },
                { value: 'published', label: t('已发布') },
                { value: 'discarded', label: t('已丢弃') },
                { value: 'all', label: t('全部草稿') },
              ]}
            />
            <span className="muted">{t('已选择 {0} 项', selection.length)}</span>
            <span className="toolbar-spacer" />
            <span className="muted">{t('支持同一集群内合并发布')}</span>
          </div>
          <Table<Draft>
            rowKey="id"
            dataSource={items}
            loading={query.isLoading}
            rowSelection={{
              selectedRowKeys: selection,
              onChange: setSelection,
              getCheckboxProps: (d) => ({
                disabled: d.status !== 'draft' || cluster.read_only || !can('edit'),
              }),
            }}
            scroll={{ x: 900 }}
            pagination={{ pageSize: 12 }}
            locale={{
              emptyText: (
                <Blank
                  text={t('这里还没有草稿，去编辑一条路由或上游吧')}
                  action={<Button onClick={() => go('/routes')}>{t('前往路由管理')}</Button>}
                />
              ),
            }}
            columns={[
              {
                title: t('变更内容'),
                key: 'title',
                render: (_, d) => (
                  <div className="resource-name">
                    <button
                      className="text-link"
                      onClick={() => {
                        setPreview(d);
                        setValidation(undefined);
                      }}
                    >
                      {d.title}
                    </button>
                    <div className="resource-subtitle mono">
                      {d.resource_type}/{d.resource_id}
                    </div>
                  </div>
                ),
              },
              {
                title: t('动作'),
                dataIndex: 'action',
                width: 90,
                render: (v) => (
                  <Tag color={v === 'delete' ? 'red' : v === 'create' ? 'green' : 'blue'}>
                    {t(actionNames[v])}
                  </Tag>
                ),
              },
              {
                title: t('状态'),
                dataIndex: 'status',
                width: 110,
                render: (v) => <StatusTag status={v} />,
              },
              {
                title: t('修改时间'),
                dataIndex: 'updated_at',
                width: 150,
                render: (value) => displayTime(value, locale),
              },
              {
                title: t('操作'),
                key: 'actions',
                width: 200,
                render: (_, d) => (
                  <Space size={0}>
                    <Button
                      type="link"
                      icon={<EyeOutlined aria-hidden="true" />}
                      onClick={() => {
                        setPreview(d);
                        setValidation(undefined);
                      }}
                    >
                      {t('预览')}
                    </Button>
                    {d.status === 'draft' && (
                      <>
                        <Button
                          type="text"
                          icon={<EditOutlined aria-hidden="true" />}
                          aria-label={t('编辑草稿 {0}', d.title)}
                          disabled={d.action === 'delete' || cluster.read_only || !can('edit')}
                          onClick={() => go(`/drafts/${d.id}/edit`)}
                        />
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined aria-hidden="true" />}
                          aria-label={t('丢弃草稿 {0}', d.title)}
                          disabled={cluster.read_only || !can('edit')}
                          onClick={() => discard(d)}
                        />
                      </>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Panel>
      )}
      <Drawer
        title={t('草稿差异预览')}
        open={!!preview}
        onClose={closePreview}
        width={Math.min(window.innerWidth - 20, 940)}
        extra={
          <Space>
            <LanguageSwitch compact />
            {preview?.status === 'draft' && (
              <>
                <Button
                  disabled={applyDraft.isPending || cluster.read_only || !can('edit')}
                  onClick={() => {
                    setSelection([preview.id]);
                    closePreview();
                    form.setFieldsValue({ title: preview.title });
                    setCreating(true);
                  }}
                >
                  {t('创建发布变更')}
                </Button>
                <Button
                  type="primary"
                  disabled={!direct.ready}
                  loading={applyDraft.isPending}
                  danger={preview.action === 'delete'}
                  onClick={() => applyDraft.mutate(preview)}
                >
                  {preview.action === 'delete' && direct.publish ? t('确认删除') : direct.label}
                </Button>
              </>
            )}
          </Space>
        }
      >
        {preview && (
          <>
            <div className="drawer-heading">
              <h2>{preview.title}</h2>
              <Space>
                <Tag>{t(kindNames[preview.resource_type])}</Tag>
                <Tag color={preview.action === 'delete' ? 'red' : 'blue'}>
                  {t(actionNames[preview.action])}
                </Tag>
                <StatusTag status={preview.status} />
              </Space>
            </div>
            {preview.status === 'draft' && direct.confirmationField}
            <DiffView before={preview.before} after={preview.after} diff={preview.diff} />
            <div className="drawer-section">
              <Space>
                <h3>{t('发布前检查')}</h3>
                <Button
                  icon={<SafetyOutlined aria-hidden="true" />}
                  loading={validate.isPending}
                  onClick={() => validate.mutate(preview.id)}
                >
                  {t('校验草稿')}
                </Button>
              </Space>
              {validation ? (
                <Checks checks={validation.checks} />
              ) : (
                <p className="muted">
                  {t('检查当前配置基线、目标 Schema 及资源引用。正式发布时还会重新检查。')}
                </p>
              )}
            </div>
          </>
        )}
      </Drawer>
      <Modal
        footer={languageFooter}
        title={t('创建发布变更')}
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        okText={t('创建并查看差异')}
        cancelText={t('取消')}
        confirmLoading={create.isPending}
      >
        <Alert
          type="info"
          showIcon
          title={t('将 {0} 份草稿合并到一个待发布变更。', selection.length)}
          description={t('此步骤不会写入网关。变更创建后内容冻结，可在详情页检查并发布。')}
        />
        <Form form={form} layout="vertical" onFinish={create.mutate} className="modal-form">
          <Form.Item
            label={t('变更标题')}
            name="title"
            rules={[{ required: true, message: t('请填写变更标题') }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item
            label={t('变更说明')}
            name="reason"
            rules={[{ required: true, whitespace: true, message: t('请说明这次变更的目的') }]}
          >
            <Input.TextArea
              rows={3}
              maxLength={2000}
              placeholder={t('例如：为订单接口增加限流策略')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export function Changes() {
  const feedback = useFeedback();
  const t = useTranslate();
  const locale = useLocale();
  const { clusterId, cluster, go } = useConsole();
  const [status, setStatus] = useState('all');
  const query = useQuery({
    queryKey: ['changes', clusterId],
    queryFn: () => api<Change[]>(`/changesets?cluster_id=${clusterId}`),
    enabled: !!clusterId,
  });
  if (!cluster) return <NoCluster />;
  return (
    <>
      <PageTitle
        eyebrow={t('变更历史')}
        title={t('发布记录')}
        description={t('从变更内容到执行结果，每一次发布都有完整记录。')}
        extra={
          <Button
            icon={<ReloadOutlined aria-hidden="true" />}
            loading={query.isFetching}
            onClick={() => query.refetch()}
          >
            {t('刷新')}
          </Button>
        }
      />
      {query.isError ? (
        <RequestError error={query.error} />
      ) : (
        <Panel>
          <div className="table-toolbar">
            <Select
              aria-label={t('发布状态')}
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: t('全部状态') },
                { value: 'pending', label: t('待发布') },
                { value: 'publishing', label: t('发布中') },
                { value: 'succeeded', label: t('已发布') },
                { value: 'failed', label: t('失败') },
                { value: 'conflict', label: t('配置冲突') },
                { value: 'unknown', label: t('待核对') },
              ]}
            />
            <span className="toolbar-spacer" />
            <span className="muted">{t('显示最近 200 条记录')}</span>
          </div>
          <Table<Change>
            rowKey="id"
            loading={query.isLoading}
            dataSource={(query.data || []).filter((c) => status === 'all' || c.status === status)}
            scroll={{ x: 800 }}
            pagination={{ pageSize: 12 }}
            locale={{ emptyText: <Blank text={t('还没有发布记录')} /> }}
            columns={[
              {
                title: t('发布内容'),
                key: 'title',
                render: (_, c) => (
                  <div className="resource-name">
                    <button className="text-link" onClick={() => go(`/changes/${c.id}`)}>
                      {c.rollback_of ? feedback(c.title) : c.title}
                    </button>
                    <div className="resource-subtitle">
                      {c.rollback_of ? feedback(c.reason) : c.reason}
                    </div>
                  </div>
                ),
              },
              {
                title: t('类型'),
                dataIndex: 'rollback_of',
                width: 90,
                render: (v) => (v ? <Tag color="purple">{t('回退')}</Tag> : <Tag>{t('发布')}</Tag>),
              },
              {
                title: t('状态'),
                dataIndex: 'status',
                width: 120,
                render: (v) => <StatusTag status={v} />,
              },
              { title: t('提交人'), dataIndex: 'created_by', width: 110 },
              {
                title: t('创建时间'),
                dataIndex: 'created_at',
                width: 150,
                render: (value) => displayTime(value, locale),
              },
              {
                title: '',
                width: 80,
                render: (_, c) => (
                  <Button type="link" onClick={() => go(`/changes/${c.id}`)}>
                    {t('详情')}
                  </Button>
                ),
              },
            ]}
          />
        </Panel>
      )}
    </>
  );
}

export function ChangeDetail() {
  const feedback = useFeedback();
  const t = useTranslate();
  const locale = useLocale();
  const { changeId } = useParams();
  const { clusters, clusterId, go, can } = useConsole();
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [activeOp, setActiveOp] = useState('');
  const [checks, setChecks] = useState<Validation>();
  const [confirm, setConfirm] = useState(false);
  const [undoNow, setUndoNow] = useState(false);
  const [ack, setAck] = useState(false);
  const [targetName, setTargetName] = useState('');
  const query = useQuery({
    queryKey: ['change', changeId],
    queryFn: () => api<Change>(`/changesets/${changeId}`),
    enabled: !!changeId,
    refetchInterval: (query) => (query.state.data?.status === 'publishing' ? 1200 : false),
  });
  const validate = useMutation({
    mutationFn: () => post<Validation>(`/changesets/${changeId}/validate`),
    onSuccess: setChecks,
    onError: (err) => message.error(feedback(err.message)),
  });
  const publish = useMutation({
    mutationFn: () => post(`/changesets/${changeId}/publish`),
    onSuccess: () => {
      setConfirm(false);
      query.refetch();
      client.invalidateQueries({ queryKey: ['changes'] });
    },
    onError: (err) => message.error(feedback(err.message)),
  });
  const rollback = useMutation({
    mutationFn: async (execute: boolean) => {
      const c = await post<Change>(`/changesets/${changeId}/rollback`);
      if (execute && c.status === 'pending') {
        try {
          await post(`/changesets/${c.id}/publish`);
        } catch (error) {
          message.error(feedback((error as Error).message));
        }
      }
      return c;
    },
    onSuccess: (c) => {
      setConfirm(false);
      setUndoNow(false);
      setChecks(undefined);
      setActiveOp('');
      go(`/changes/${c.id}`, c.cluster_id);
      client.invalidateQueries({ queryKey: ['changes'] });
    },
    onError: (err) => message.error(feedback(err.message)),
  });
  const reconcile = useMutation({
    mutationFn: () => post(`/changesets/${changeId}/reconcile`),
    onSuccess: () => {
      query.refetch();
      message.success(t('结果核对完成'));
    },
    onError: (err) => message.error(feedback(err.message)),
  });
  useEffect(() => {
    setChecks(undefined);
    setActiveOp('');
    setAck(false);
    setTargetName('');
  }, [changeId]);
  useEffect(() => {
    if (query.data && ['succeeded', 'failed', 'conflict', 'unknown'].includes(query.data.status)) {
      // A newly mounted editor must receive the post-release snapshot and hash.
      for (const operation of query.data.operations || []) {
        client.removeQueries({
          queryKey: [
            'resource',
            query.data.cluster_id,
            operation.resource_type,
            operation.resource_id,
          ],
          type: 'inactive',
        });
      }
      client.invalidateQueries({ queryKey: ['resources'] });
      client.invalidateQueries({ queryKey: ['drafts'] });
      client.invalidateQueries({ queryKey: ['changes'] });
      client.invalidateQueries({ queryKey: ['audit'] });
    }
  }, [query.data?.status, query.data?.id, client]);
  if (query.isLoading) return <Loading />;
  if (query.error) return <RequestError error={query.error} />;
  const change = query.data;
  if (!change) return null;
  const cluster = clusters.find((c) => c.id === change.cluster_id);
  if (clusterId && change.cluster_id !== clusterId)
    return (
      <Alert
        type="warning"
        title={t('此变更属于另一个集群')}
        action={
          <Button onClick={() => go(`/changes/${change.id}`, change.cluster_id)}>
            {t('切换到对应集群')}
          </Button>
        }
      />
    );
  const operations = change.operations || [];
  const operation = operations.find((o) => o.id === activeOp) || operations[0];
  const appliedCount = operations.filter((o) => o.status === 'applied').length;
  const isPending = change.status === 'pending';
  const isPublishing = change.status === 'publishing';
  const canExecute =
    !cluster?.read_only && can(change.rollback_of ? 'rollback' : 'publish', change.cluster_id);
  const needsReconcile = change.status === 'unknown' || isPublishing;
  const canRollback =
    appliedCount > 0 &&
    !isPublishing &&
    change.status !== 'unknown' &&
    change.status !== 'cancelled';
  return (
    <>
      <button className="back-link" onClick={() => go('/changes')}>
        <ArrowLeftOutlined aria-hidden="true" /> {t('返回发布记录')}
      </button>
      <PageTitle
        eyebrow={change.rollback_of ? t('回退预览') : t('发布审查')}
        title={change.rollback_of ? feedback(change.title) : change.title}
        description={change.rollback_of ? feedback(change.reason) : change.reason}
        extra={
          <>
            <StatusTag status={change.status} />
            {canRollback && (
              <Button
                icon={<HistoryOutlined aria-hidden="true" />}
                loading={rollback.isPending}
                disabled={cluster?.read_only || !can('rollback', change.cluster_id)}
                onClick={() => rollback.mutate(false)}
              >
                {t('生成回退变更')}
              </Button>
            )}
            {canRollback && (
              <Button
                icon={<HistoryOutlined aria-hidden="true" />}
                danger
                disabled={cluster?.read_only || !can('rollback', change.cluster_id)}
                onClick={() => {
                  setAck(false);
                  setTargetName('');
                  setUndoNow(true);
                  setConfirm(true);
                }}
              >
                {t('回退已应用配置')}
              </Button>
            )}
            {isPending && (
              <Button
                type="primary"
                icon={<RocketOutlined aria-hidden="true" />}
                disabled={
                  !canExecute ||
                  checks?.ok === false ||
                  (operations.some((op) => op.draft_id) && !checks?.ok)
                }
                onClick={() => {
                  setUndoNow(false);
                  setAck(false);
                  setTargetName('');
                  setConfirm(true);
                }}
              >
                {t('发布到网关')}
              </Button>
            )}
          </>
        }
      />
      <div className="release-context">
        <div>
          <span>{t('目标集群')}</span>
          <strong>{cluster?.name || change.cluster_id}</strong>
        </div>
        <div>
          <span>{t('环境')}</span>
          <Tag color={cluster?.environment === 'production' ? 'orange' : 'blue'}>
            {t(environmentNames[cluster?.environment || '']) || '—'}
          </Tag>
        </div>
        <div>
          <span>{t('提交人')}</span>
          <strong>{change.created_by}</strong>
        </div>
        <div>
          <span>{t('创建时间')}</span>
          <strong>{displayTime(change.created_at, locale)}</strong>
        </div>
        <div>
          <span>{t('资源变更')}</span>
          <strong>
            {operations.length} {t('项')}
          </strong>
        </div>
      </div>
      {change.rollback_of && (
        <Alert
          type="info"
          showIcon
          title={isPending ? t('这是一个新的回退变更，尚需校验和发布。') : t('回退记录')}
          description={t(
            '回退将恢复原发布前的配置。如果资源在原发布后已被修改，冲突检测会阻止覆盖。',
          )}
          action={
            <Button type="link" onClick={() => go(`/changes/${change.rollback_of}`)}>
              {t('查看原变更')}
            </Button>
          }
        />
      )}
      {change.status === 'succeeded' && (
        <Alert
          type="success"
          showIcon
          title={t('配置已写入，并通过 Admin API 回读确认')}
          description={t('此结果确认配置状态；业务请求与所有数据面节点的生效情况仍需独立验证。')}
        />
      )}
      {['failed', 'conflict', 'unknown'].includes(change.status) && (
        <Alert
          type={change.status === 'unknown' ? 'warning' : 'error'}
          showIcon
          title={
            change.status === 'conflict'
              ? t('检测到配置冲突，发布已停止')
              : change.status === 'unknown'
                ? t('部分结果尚未确认，请先核对')
                : t('发布未全部完成')
          }
          description={t(
            '逐项执行结果保留在下方。已应用的操作不会自动覆盖回去，可生成回退变更处理。',
          )}
        />
      )}
      <div className="release-steps">
        <Steps
          size="small"
          current={change.status === 'succeeded' ? 3 : isPublishing ? 2 : checks?.ok ? 1 : 0}
          items={[
            { title: t('审查差异'), icon: <FileDoneOutlined aria-hidden="true" /> },
            { title: t('发布前校验'), icon: <SafetyOutlined aria-hidden="true" /> },
            { title: t('应用配置'), icon: <RocketOutlined aria-hidden="true" /> },
            { title: t('回读确认'), icon: <CheckCircleOutlined aria-hidden="true" /> },
          ]}
        />
      </div>
      <div className="release-grid">
        <Panel title={t('变更资源')} className="release-resource-panel">
          <div className="operation-list">
            {operations.map((op) => (
              <button
                className={`operation-item ${operation?.id === op.id ? 'selected' : ''}`}
                key={op.id}
                onClick={() => setActiveOp(op.id)}
              >
                <div>
                  <span className={`operation-action ${op.action}`}>
                    {t(actionNames[op.action])}
                  </span>
                  <strong>{op.after?.name || op.before?.name || op.resource_id}</strong>
                </div>
                <small className="mono">
                  {op.resource_type}/{op.resource_id}
                </small>
                <StatusTag status={op.status} />
              </button>
            ))}
          </div>
        </Panel>
        <Panel
          title={
            operation
              ? `${t(kindNames[operation.resource_type])} · ${operation.resource_id}`
              : t('配置差异')
          }
        >
          {operation && (
            <>
              <DiffView before={operation.before} after={operation.after} diff={operation.diff} />
              {operation.error && (
                <div className="operation-error">
                  <Alert
                    showIcon
                    type={operation.status === 'unknown' ? 'warning' : 'error'}
                    title={feedback(operation.error)}
                  />
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
      <Panel
        title={t('发布检查与执行记录')}
        extra={
          <Space>
            {isPending && (
              <Button
                icon={<SafetyOutlined aria-hidden="true" />}
                loading={validate.isPending}
                onClick={() => validate.mutate()}
              >
                {t('执行发布前校验')}
              </Button>
            )}
            {needsReconcile && (
              <Button
                icon={<ReloadOutlined aria-hidden="true" />}
                disabled={!canExecute}
                loading={reconcile.isPending}
                onClick={() => reconcile.mutate()}
              >
                {t('核对执行结果')}
              </Button>
            )}
            <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={() => query.refetch()}>
              {t('刷新状态')}
            </Button>
          </Space>
        }
      >
        {checks && <Checks checks={checks.checks} />}
        {isPending && !checks && (
          <div className="empty-checks">
            <SafetyOutlined aria-hidden="true" />
            <div>
              <strong>{t('发布前先完成校验')}</strong>
              <p>{t('检查当前配置版本、网关 Schema 和引用关系。正式执行时会再次检查。')}</p>
            </div>
          </div>
        )}
        {!isPending && (
          <div className="execution-log">
            <Timeline
              items={operations.map((op) => ({
                color:
                  op.status === 'applied'
                    ? 'green'
                    : ['failed', 'conflict'].includes(op.status)
                      ? 'red'
                      : 'gray',
                children: (
                  <div>
                    <Space>
                      <strong>
                        {t(actionNames[op.action])} {t(kindNames[op.resource_type])} ·{' '}
                        {op.resource_id}
                      </strong>
                      <StatusTag status={op.status} />
                    </Space>
                    <p>
                      {op.status === 'applied'
                        ? t('Admin API 写入成功，回读配置已确认。')
                        : feedback(op.error) || t('等待执行。')}
                    </p>
                  </div>
                ),
              }))}
            />
          </div>
        )}
      </Panel>
      {['pending', 'failed', 'conflict'].includes(change.status) && !appliedCount && (
        <div className="page-footnote">
          <Button
            type="link"
            danger
            disabled={!canExecute}
            onClick={() =>
              modal.confirm({
                footer: languageFooter,
                title: messageText('取消这次变更？'),
                content: messageText(
                  operations.some((op) => op.draft_id)
                    ? '关联草稿将标记为已丢弃，之后可基于网关最新配置重新编辑。'
                    : '取消后，此变更不会写入网关。',
                ),
                okText: messageText('取消变更'),
                cancelText: messageText('保留'),
                onOk: async () => {
                  try {
                    await post(`/changesets/${changeId}/cancel`);
                    query.refetch();
                    client.invalidateQueries({ queryKey: ['drafts'] });
                  } catch (error) {
                    message.error(feedback((error as Error).message));
                    throw error;
                  }
                },
              })
            }
          >
            {operations.some((op) => op.draft_id) ? t('取消变更并释放草稿') : t('取消变更')}
          </Button>
        </div>
      )}
      <Modal
        footer={languageFooter}
        title={undoNow ? t('确认回退到变更前的配置') : t('确认发布到网关')}
        open={confirm}
        onCancel={() => setConfirm(false)}
        onOk={() => (undoNow ? rollback.mutate(true) : publish.mutate())}
        okText={undoNow ? t('确认回退') : t('确认发布')}
        cancelText={t('返回检查')}
        confirmLoading={publish.isPending || rollback.isPending}
        okButtonProps={{
          disabled: !ack || (cluster?.environment === 'production' && targetName !== cluster.name),
        }}
      >
        <div className="publish-confirm">
          <Alert
            showIcon
            type={cluster?.environment === 'production' ? 'warning' : 'info'}
            title={`${cluster?.name} · ${t(environmentNames[cluster?.environment || ''])}`}
            description={
              undoNow
                ? t('将恢复此变更中已应用的 {0} 项配置。', appliedCount)
                : t('将应用 {0} 项资源变更。配置写入后会影响实际请求。', operations.length)
            }
          />
          <p>{change.rollback_of ? feedback(change.reason) : change.reason}</p>
          {cluster?.environment === 'production' && (
            <Form.Item label={t('输入集群名称“{0}”确认目标', cluster.name)}>
              <Input value={targetName} onChange={(e) => setTargetName(e.target.value)} />
            </Form.Item>
          )}
          <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)}>
            {t('我已核对目标集群与配置差异')}
          </Checkbox>
        </div>
      </Modal>
    </>
  );
}

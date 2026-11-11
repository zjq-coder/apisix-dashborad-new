import { useTranslate } from '../i18n';
import { Alert } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useConsole } from '../context';
import { Loading, NoCluster, RequestError } from '../components/Common';
import { ManagedEditor, managedKind } from './Managed';
import { EditorForm } from '../editor/EditorForm';
import type { Draft, Resource, ResourceKind } from '../types';

export function ResourceEditor({ kind: givenKind }: { kind?: ResourceKind }) {
  const t = useTranslate();
  const { resourceId, draftId } = useParams();
  const [params] = useSearchParams();
  const copyId = params.get('copy');
  const { clusterId, go } = useConsole();
  const draft = useQuery({
    queryKey: ['draft', draftId],
    queryFn: () => api<Draft>(`/drafts/${draftId}`),
    enabled: !!draftId,
  });
  const resource = useQuery({
    queryKey: ['resource', clusterId, givenKind, resourceId || copyId],
    queryFn: () =>
      api<Resource>(`/clusters/${clusterId}/resources/${givenKind}/${resourceId || copyId}`),
    enabled: !!clusterId && !!givenKind && !!(resourceId || copyId) && !draftId,
  });
  if (!clusterId) return <NoCluster />;
  if ((draftId && draft.isLoading) || ((resourceId || copyId) && resource.isLoading))
    return <Loading />;
  if (draft.error || resource.error)
    return (
      <RequestError
        error={draft.error || resource.error}
        retry={() => {
          draft.refetch();
          resource.refetch();
        }}
      />
    );
  const kind = givenKind || draft.data?.resource_type;
  if (!kind) return <Loading />;
  if (draft.data && draft.data.cluster_id !== clusterId)
    return <Alert type="warning" showIcon title={t('此草稿不属于当前集群，请切换到对应集群。')} />;
  if (draft.data && (draft.data.status !== 'draft' || draft.data.action === 'delete'))
    return (
      <Alert type="info" showIcon title={t('此草稿无法继续编辑，请在草稿箱或发布记录中查看。')} />
    );
  if (draft.data && managedKind(kind))
    return (
      <ManagedEditor
        key={draft.data.id}
        kind={kind}
        draft={draft.data}
        onDone={() => go('/drafts')}
      />
    );
  return (
    <EditorForm
      key={`${clusterId}:${kind}:${draftId || resourceId || copyId || 'new'}`}
      kind={kind}
      resource={resource.data}
      draft={draft.data}
      copying={!!copyId}
    />
  );
}

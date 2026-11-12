import { translate, type Locale } from './i18n';

export type JsonObject = Record<string, any>;
export type ResourceKind = 'routes' | 'upstreams' | 'consumers';
export interface Cluster {
  id: string;
  name: string;
  environment: 'development' | 'staging' | 'production';
  url: string;
  description: string;
  read_only: boolean;
  status: string;
  version: string;
  last_checked: string | null;
  probe_latency_ms?: number | null;
  probe_error?: string;
  created_at: string;
}
export interface Resource {
  id: string;
  value: JsonObject;
  hash: string;
  modified_index: number;
}
export interface Difference {
  path: string;
  kind: 'add' | 'remove' | 'replace';
  before: unknown;
  after: unknown;
  sensitive: boolean;
}
export interface Draft {
  id: string;
  cluster_id: string;
  resource_type: ResourceKind;
  resource_id: string;
  action: 'create' | 'update' | 'delete';
  title: string;
  status: string;
  base_hash: string;
  revision: number;
  before: JsonObject | null;
  after: JsonObject | null;
  diff: Difference[];
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface Operation {
  id: string;
  draft_id: string;
  resource_type: ResourceKind;
  resource_id: string;
  action: string;
  status: string;
  base_hash: string;
  before: JsonObject | null;
  after: JsonObject | null;
  actual_after: JsonObject | null;
  diff: Difference[];
  error: string;
}
export interface Change {
  id: string;
  cluster_id: string;
  title: string;
  reason: string;
  status: string;
  rollback_of: string;
  operations?: Operation[];
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface Check {
  name: string;
  ok: boolean;
  message: string;
}
export interface Validation {
  preview?: Pick<Operation, 'before' | 'after' | 'diff'>;
  ok: boolean;
  checks: Check[];
}
export type Capability = 'edit' | 'publish' | 'rollback' | 'audit';
export type Grants = Record<string, Capability[]>;
export interface Session {
  username: string;
  role: 'administrator' | 'member';
  grants: Grants;
  csrf_token: string;
}
export const environmentNames: Record<string, string> = {
  development: '开发环境',
  staging: '测试环境',
  production: '生产环境',
};
export const actionNames: Record<string, string> = {
  create: '新增',
  update: '修改',
  delete: '删除',
};
export const kindNames: Record<string, string> = {
  services: '服务',
  plugin_configs: '共享插件配置',
  global_rules: '全局规则',
  plugin_metadata: '插件元数据',
  stream_routes: 'Stream 路由',
  protos: 'Proto 协议',
  secrets: 'Secret 管理器',
  consumer_groups: '消费者组',
  credentials: '独立凭据',
  ssls: 'TLS 证书',
  routes: '路由',
  upstreams: '上游',
  consumers: '消费者',
};
export const statusNames: Record<string, string> = {
  pending: '待发布',
  publishing: '发布中',
  succeeded: '已发布',
  failed: '失败',
  conflict: '配置冲突',
  unknown: '待核对',
  cancelled: '已取消',
  draft: '草稿',
  submitted: '已提交',
  published: '已发布',
  discarded: '已丢弃',
  applied: '已应用',
  applying: '写入中',
  skipped: '未执行',
};
export function displayTime(value: string | null | undefined, locale: Locale) {
  return value
    ? new Date(value).toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : translate(locale, '尚未检测');
}
export function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

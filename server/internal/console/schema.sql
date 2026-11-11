CREATE TABLE IF NOT EXISTS clusters (
 id text PRIMARY KEY, name text NOT NULL, environment text NOT NULL, url text NOT NULL,
 description text NOT NULL DEFAULT '', read_only boolean NOT NULL DEFAULT false, key_cipher text NOT NULL,
 version text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'unchecked', last_checked timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, username text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
 id text PRIMARY KEY, cluster_id text NOT NULL REFERENCES clusters(id), resource_type text NOT NULL,
 resource_id text NOT NULL, action text NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'draft',
 base_hash text NOT NULL, payload_cipher text NOT NULL, revision integer NOT NULL DEFAULT 1,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS active_draft_resource ON drafts(cluster_id,resource_type,resource_id) WHERE status='draft';
CREATE TABLE IF NOT EXISTS changesets (
 id text PRIMARY KEY, cluster_id text NOT NULL REFERENCES clusters(id), title text NOT NULL,
 reason text NOT NULL, status text NOT NULL DEFAULT 'pending', rollback_of text NOT NULL DEFAULT '',
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_rollback_per_change ON changesets(rollback_of) WHERE rollback_of <> '';
CREATE TABLE IF NOT EXISTS operations (
 id text PRIMARY KEY, change_id text NOT NULL REFERENCES changesets(id), draft_id text NOT NULL DEFAULT '',
 position integer NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL, action text NOT NULL,
 status text NOT NULL DEFAULT 'pending', base_hash text NOT NULL, payload_cipher text NOT NULL,
 actual_cipher text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '', UNIQUE(change_id,position)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
 detail text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_cluster ON drafts(cluster_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS changes_cluster ON changesets(cluster_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_time ON audit_events(created_at DESC);
CREATE TABLE IF NOT EXISTS console_accounts (
 username text PRIMARY KEY, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('administrator','member')),
 enabled boolean NOT NULL DEFAULT true, bootstrap boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS console_bootstrap ON console_accounts(bootstrap) WHERE bootstrap;
CREATE TABLE IF NOT EXISTS console_grants (
 username text NOT NULL REFERENCES console_accounts(username) ON DELETE CASCADE,
 cluster_id text NOT NULL REFERENCES clusters(id), permissions text[] NOT NULL,
 PRIMARY KEY(username,cluster_id), CHECK(permissions <@ ARRAY['edit','publish','rollback','audit']::text[])
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(username);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS cluster_id text NOT NULL DEFAULT '';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'legacy';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS http_status integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS audit_cluster_id ON audit_events(cluster_id,id DESC);
UPDATE audit_events a SET cluster_id=c.id FROM clusters c WHERE a.outcome='legacy' AND a.cluster_id='' AND a.action LIKE 'cluster.%' AND a.target=c.id;
UPDATE audit_events a SET cluster_id=d.cluster_id FROM drafts d WHERE a.outcome='legacy' AND a.cluster_id='' AND a.action LIKE 'draft.%' AND a.target=d.id;
UPDATE audit_events a SET cluster_id=c.cluster_id FROM changesets c WHERE a.outcome='legacy' AND a.cluster_id='' AND a.action LIKE 'change.%' AND a.target=c.id;

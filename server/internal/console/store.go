package console

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"time"
)

//go:embed schema.sql
var schemaSQL string

type Store struct {
	DB    *sql.DB
	Vault *Vault
}

func OpenStore(ctx context.Context, url string, vault *Vault) (*Store, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(15)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err = db.PingContext(ctx); err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(7419137)"); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, schemaSQL); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &Store{DB: db, Vault: vault}, nil
}

type scanner interface{ Scan(...any) error }

func scanCluster(row scanner) (Cluster, error) {
	var c Cluster
	err := row.Scan(&c.ID, &c.Name, &c.Environment, &c.URL, &c.Description, &c.ReadOnly, &c.KeyCipher, &c.Version, &c.Status, &c.LastChecked, &c.CreatedAt)
	return c, err
}

const clusterColumns = `id,name,environment,url,description,read_only,key_cipher,version,status,last_checked,created_at`

func (s *Store) Cluster(ctx context.Context, id string) (Cluster, error) {
	return scanCluster(s.DB.QueryRowContext(ctx, `SELECT `+clusterColumns+` FROM clusters WHERE id=$1`, id))
}
func (s *Store) Clusters(ctx context.Context) ([]Cluster, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+clusterColumns+` FROM clusters WHERE ($1::text[] IS NULL OR id=ANY($1)) ORDER BY created_at`, identity(ctx).scope("view"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Cluster{}
	for rows.Next() {
		c, err := scanCluster(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

const draftColumns = `id,cluster_id,resource_type,resource_id,action,title,status,base_hash,revision,created_by,created_at,updated_at,payload_cipher`

func (s *Store) scanDraft(row scanner) (Draft, error) {
	var d Draft
	var blob string
	err := row.Scan(&d.ID, &d.ClusterID, &d.ResourceType, &d.ResourceID, &d.Action, &d.Title, &d.Status, &d.BaseHash, &d.Revision, &d.CreatedBy, &d.CreatedAt, &d.UpdatedAt, &blob)
	if err != nil {
		return d, err
	}
	var payload DraftPayload
	if err = s.Vault.Open(blob, &payload); err != nil {
		return d, err
	}
	d.Before = payload.Before
	d.After = payload.After
	d.SensitivePaths = payload.protectedPaths()
	return d, nil
}
func (s *Store) Draft(ctx context.Context, id string) (Draft, error) {
	return s.scanDraft(s.DB.QueryRowContext(ctx, `SELECT `+draftColumns+` FROM drafts WHERE id=$1`, id))
}
func (s *Store) Drafts(ctx context.Context, clusterID string) ([]Draft, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+draftColumns+` FROM drafts WHERE ($1='' OR cluster_id=$1) AND ($2::text[] IS NULL OR cluster_id=ANY($2)) ORDER BY updated_at DESC LIMIT 500`, clusterID, identity(ctx).scope("view"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Draft{}
	for rows.Next() {
		d, err := s.scanDraft(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, publicDraft(d))
	}
	return out, rows.Err()
}
func (s *Store) InsertDraft(ctx context.Context, d Draft) error {
	return s.insertDraft(ctx, s.DB, d)
}

type draftExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func (s *Store) insertDraft(ctx context.Context, executor draftExecutor, d Draft) error {
	blob, err := s.Vault.Seal(DraftPayload{SecretPolicyVersion: 1, Before: d.Before, After: d.After, SensitivePaths: d.SensitivePaths})
	if err != nil {
		return err
	}
	_, err = executor.ExecContext(ctx, `INSERT INTO drafts(id,cluster_id,resource_type,resource_id,action,title,base_hash,payload_cipher,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, d.ID, d.ClusterID, d.ResourceType, d.ResourceID, d.Action, d.Title, d.BaseHash, blob, d.CreatedBy)
	return err
}

func (s *Store) Change(ctx context.Context, id string) (Change, error) {
	var c Change
	err := s.DB.QueryRowContext(ctx, `SELECT id,cluster_id,title,reason,status,rollback_of,created_by,created_at,updated_at FROM changesets WHERE id=$1`, id).Scan(&c.ID, &c.ClusterID, &c.Title, &c.Reason, &c.Status, &c.RollbackOf, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return c, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,draft_id,resource_type,resource_id,action,status,base_hash,payload_cipher,actual_cipher,error FROM operations WHERE change_id=$1 ORDER BY position`, id)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	c.Operations = []Operation{}
	for rows.Next() {
		var op Operation
		var payload, actual string
		if err = rows.Scan(&op.ID, &op.DraftID, &op.ResourceType, &op.ResourceID, &op.Action, &op.Status, &op.BaseHash, &payload, &actual, &op.Error); err != nil {
			return c, err
		}
		var p DraftPayload
		if err = s.Vault.Open(payload, &p); err != nil {
			return c, err
		}
		op.Before = p.Before
		op.After = p.After
		op.SensitivePaths = p.protectedPaths()
		if actual != "" {
			if err = s.Vault.Open(actual, &op.ActualAfter); err != nil {
				return c, err
			}
		}
		c.Operations = append(c.Operations, op)
	}
	return c, rows.Err()
}
func (s *Store) Changes(ctx context.Context, clusterID string) ([]Change, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,cluster_id,title,reason,status,rollback_of,created_by,created_at,updated_at FROM changesets WHERE ($1='' OR cluster_id=$1) AND ($2::text[] IS NULL OR cluster_id=ANY($2)) ORDER BY created_at DESC LIMIT 200`, clusterID, identity(ctx).scope("view"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Change{}
	for rows.Next() {
		var c Change
		if err = rows.Scan(&c.ID, &c.ClusterID, &c.Title, &c.Reason, &c.Status, &c.RollbackOf, &c.CreatedBy, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (s *Store) OperationResult(ctx context.Context, id, status, message string, actual Object) error {
	blob, err := s.Vault.Seal(actual)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx, `UPDATE operations SET status=$2,error=$3,actual_cipher=$4 WHERE id=$1`, id, status, message, blob)
	return err
}
func (s *Store) ChangeStatus(ctx context.Context, id, status string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE changesets SET status=$2,updated_at=now() WHERE id=$1`, id, status)
	return err
}
func (s *Store) LockCluster(ctx context.Context, id string) (func(), error) {
	conn, err := s.DB.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var locked bool
	err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, "publish:"+id).Scan(&locked)
	if err != nil || !locked {
		conn.Close()
		return nil, fmt.Errorf("该集群正在执行另一项发布，请稍后重试")
	}
	return func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = conn.ExecContext(cleanup, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, "publish:"+id)
		_ = conn.Close()
	}, nil
}

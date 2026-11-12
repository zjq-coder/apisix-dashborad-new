package console

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

type probeTarget struct {
	id, url, key string
	due          time.Time
}

// Reserve due probes in PostgreSQL so multiple Dashboard instances share the work.
func (s *Server) claimProbes(ctx context.Context) ([]probeTarget, error) {
	rows, err := s.Store.DB.QueryContext(ctx, `WITH due AS (
		SELECT id FROM clusters WHERE removed_at IS NULL AND next_probe_at <= now()
		ORDER BY next_probe_at,id LIMIT 4 FOR UPDATE SKIP LOCKED
	) UPDATE clusters c SET next_probe_at=now()+interval '1 minute' FROM due
	WHERE c.id=due.id RETURNING c.id,c.url,c.key_cipher,c.next_probe_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var targets []probeTarget
	for rows.Next() {
		var p probeTarget
		if err := rows.Scan(&p.id, &p.url, &p.key, &p.due); err != nil {
			return nil, err
		}
		targets = append(targets, p)
	}
	return targets, rows.Err()
}

func (s *Server) probeLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		targets, err := s.claimProbes(ctx)
		if err != nil && ctx.Err() == nil {
			slog.Warn("cluster probe scheduling failed")
		}
		var batch sync.WaitGroup
		for _, target := range targets {
			batch.Add(1)
			go func(p probeTarget) {
				defer batch.Done()
				_, _, _, err := s.checkConnectivity(ctx, p)
				if err != nil && ctx.Err() == nil {
					slog.Warn("cluster probe result could not be saved", "cluster", p.id)
				}
			}(target)
		}
		batch.Wait()
		if len(targets) == 4 {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Only the authenticated Admin API plugin list is needed for a heartbeat.
// Keep diagnostic errors separate from errors persisting the observation.
func (s *Server) checkConnectivity(ctx context.Context, p probeTarget) (*HTTPGateway, int, error, error) {
	var key string
	var g *HTTPGateway
	var plugins []string
	err := s.Store.Vault.Open(p.key, &key)
	if err != nil {
		err = errors.New("集群凭据解密失败，请检查服务端密钥")
	} else {
		g, err = NewGateway(p.url, key)
	}
	started := time.Now()
	if err == nil {
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = g.request(probeCtx, http.MethodGet, "/plugins/list", nil, &plugins)
		var response *APIError
		if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			err = errors.New("Admin API 探测超时")
		} else if errors.As(err, &response) {
			switch response.Status {
			case http.StatusUnauthorized:
				err = errors.New("Admin API 认证失败（HTTP 401），请核对连接中保存的管理密钥")
			case http.StatusForbidden:
				err = errors.New("Admin API 拒绝访问（HTTP 403），请核对来源地址和密钥权限")
			}
		}
		cancel()
		if err == nil && plugins == nil {
			err = errors.New("Admin API 插件列表格式无效")
		}
	}
	latency := time.Since(started).Milliseconds()
	status, detail, version := "connected", "", ""
	if err != nil {
		status, detail = "error", err.Error()
	}
	if g != nil {
		version = g.Version
	}
	// A deleted connection, edited credential or newer probe wins over an in-flight result.
	_, dbErr := s.Store.DB.ExecContext(ctx, `UPDATE clusters SET status=$3,probe_error=$4,probe_latency_ms=$5,last_checked=now(),
		version=COALESCE(NULLIF($6,''),version) WHERE id=$1 AND next_probe_at=$2 AND removed_at IS NULL`, p.id, p.due, status, detail, latency, version)
	return g, len(plugins), err, dbErr
}

func (g *HTTPGateway) collectionCount(ctx context.Context, kind string) (int, error) {
	var page struct {
		Total *int `json:"total"`
	}
	// APISIX 3.x accepts page sizes from 10 to 500.
	if err := g.request(ctx, http.MethodGet, "/"+kind+"?page=1&page_size=10", nil, &page); err != nil {
		return 0, err
	}
	if page.Total == nil || *page.Total < 0 {
		return 0, errors.New("目标版本的资源列表格式尚未支持")
	}
	return *page.Total, nil
}

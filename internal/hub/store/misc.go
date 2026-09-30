package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

func timestamppbOrNil(t *time.Time) *timestamppb.Timestamp {
	if t == nil || t.IsZero() {
		return nil
	}
	return timestamppb.New(*t)
}

// SaveCatalog upserts the latest catalog snapshot for a cluster.
func (s *Store) SaveCatalog(ctx context.Context, clusterID string, c *kmatev1.Catalog) error {
	b, err := proto.Marshal(c)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO catalog_snapshots(cluster_id, version, json, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(cluster_id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at`,
		clusterID, c.GetVersion(), b, time.Now().UTC())
	return err
}

// GetCatalog returns the stored snapshot.
func (s *Store) GetCatalog(ctx context.Context, clusterID string) (*kmatev1.Catalog, error) {
	var b []byte
	err := s.db.QueryRowContext(ctx, `SELECT json FROM catalog_snapshots WHERE cluster_id = ?`, clusterID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var c kmatev1.Catalog
	if err := proto.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// AuditEvent is a persisted audit record.
type AuditEvent struct {
	ID        string
	Time      time.Time
	User      string
	ClusterID string
	Action    string
	Target    string
	Result    string
}

// Audit writes an audit event.
func (s *Store) Audit(ctx context.Context, e AuditEvent) error {
	if e.ID == "" {
		e.ID = uuid.NewString()
	}
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO audit_events(id, time, user, cluster_id, action, target, result) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.Time, e.User, e.ClusterID, e.Action, e.Target, e.Result)
	return err
}

// ListAudit returns recent audit events, newest first.
func (s *Store) ListAudit(ctx context.Context, clusterID string, limit int) ([]*kmatev1.AuditEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	var rows *sql.Rows
	var err error
	if clusterID == "" {
		rows, err = s.db.QueryContext(ctx, `SELECT id, time, user, cluster_id, action, target, result FROM audit_events ORDER BY time DESC LIMIT ?`, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT id, time, user, cluster_id, action, target, result FROM audit_events WHERE cluster_id = ? ORDER BY time DESC LIMIT ?`, clusterID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*kmatev1.AuditEvent
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(&e.ID, &e.Time, &e.User, &e.ClusterID, &e.Action, &e.Target, &e.Result); err != nil {
			return nil, err
		}
		out = append(out, &kmatev1.AuditEvent{Id: e.ID, Time: timestamppb.New(e.Time), User: e.User, ClusterId: e.ClusterID, Action: e.Action, Target: e.Target, Result: e.Result})
	}
	return out, rows.Err()
}

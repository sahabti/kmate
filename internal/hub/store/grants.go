package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/kmate-dev/kmate/internal/hub/auth"
)

// Grant gives one user access to one cluster. Namespaces empty means all.
type Grant struct {
	ID         string
	UserID     string
	ClusterID  string
	Role       string
	Namespaces []string
	CreatedAt  time.Time
}

// SetGrant creates or replaces a user's grant on a cluster.
func (s *Store) SetGrant(ctx context.Context, g *Grant) (*Grant, error) {
	if g.ID == "" {
		g.ID = uuid.NewString()
	}
	if g.CreatedAt.IsZero() {
		g.CreatedAt = time.Now().UTC()
	}
	ns, err := encodeList(g.Namespaces)
	if err != nil {
		return nil, err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO cluster_grants(id, user_id, cluster_id, role, namespaces, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, cluster_id) DO UPDATE SET role = excluded.role, namespaces = excluded.namespaces`,
		g.ID, g.UserID, g.ClusterID, g.Role, ns, g.CreatedAt)
	if err != nil {
		return nil, err
	}
	return s.GetGrant(ctx, g.UserID, g.ClusterID)
}

// GetGrant returns one grant.
func (s *Store) GetGrant(ctx context.Context, userID, clusterID string) (*Grant, error) {
	return scanGrant(s.db.QueryRowContext(ctx,
		`SELECT id, user_id, cluster_id, role, namespaces, created_at FROM cluster_grants WHERE user_id = ? AND cluster_id = ?`,
		userID, clusterID))
}

// DeleteGrant removes a grant.
func (s *Store) DeleteGrant(ctx context.Context, userID, clusterID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM cluster_grants WHERE user_id = ? AND cluster_id = ?`, userID, clusterID)
	return err
}

// ListGrantsForUser returns every grant a user holds.
func (s *Store) ListGrantsForUser(ctx context.Context, userID string) ([]*Grant, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, cluster_id, role, namespaces, created_at FROM cluster_grants WHERE user_id = ? ORDER BY cluster_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Grant
	for rows.Next() {
		var g Grant
		var ns string
		if err := rows.Scan(&g.ID, &g.UserID, &g.ClusterID, &g.Role, &ns, &g.CreatedAt); err != nil {
			return nil, err
		}
		g.Namespaces = decodeList(ns)
		out = append(out, &g)
	}
	return out, rows.Err()
}

func scanGrant(row *sql.Row) (*Grant, error) {
	var g Grant
	var ns string
	err := row.Scan(&g.ID, &g.UserID, &g.ClusterID, &g.Role, &ns, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	g.Namespaces = decodeList(ns)
	return &g, nil
}

func encodeList(v []string) (string, error) {
	if len(v) == 0 {
		return "", nil
	}
	b, err := json.Marshal(v)
	return string(b), err
}

func decodeList(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	if json.Unmarshal([]byte(s), &out) != nil {
		return nil
	}
	return out
}

// ---- auth.Directory implementation ----

// AuthRecord returns the account fields authorization needs.
func (s *Store) AuthRecord(ctx context.Context, userID string) (*auth.Record, error) {
	u, err := s.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &auth.Record{
		ID: u.ID, Email: u.Email, Role: u.Role, Active: u.Active,
		K8sUser: u.EffectiveK8sUser(), K8sGroups: u.EffectiveK8sGroups(),
	}, nil
}

// AuthGrants returns the user's per-cluster grants.
func (s *Store) AuthGrants(ctx context.Context, userID string) ([]auth.Grant, error) {
	gs, err := s.ListGrantsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]auth.Grant, 0, len(gs))
	for _, g := range gs {
		out = append(out, auth.Grant{ClusterID: g.ClusterID, Role: g.Role, Namespaces: g.Namespaces})
	}
	return out, nil
}

package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

// Cluster status values.
const (
	StatusPending = "PENDING"
	StatusOnline  = "ONLINE"
	StatusOffline = "OFFLINE"
)

// Cluster is a registered cluster.
type Cluster struct {
	ID             string
	Name           string
	Status         string
	Info           *kmatev1.ClusterInfo
	LastHeartbeat  *time.Time
	CreatedAt      time.Time
	Capabilities   []string
	AgentTokenHash string
}

// Proto converts to the API type.
func (c *Cluster) Proto() *kmatev1.Cluster {
	p := &kmatev1.Cluster{
		Id:           c.ID,
		Name:         c.Name,
		Info:         c.Info,
		Capabilities: c.Capabilities,
		CreatedAt:    timestamppbOrNil(&c.CreatedAt),
	}
	switch c.Status {
	case StatusOnline:
		p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_ONLINE
	case StatusOffline:
		p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_OFFLINE
	default:
		p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_PENDING
	}
	if c.LastHeartbeat != nil {
		p.LastHeartbeat = timestamppbOrNil(c.LastHeartbeat)
	}
	p.SharedIdentity = true
	for _, cap := range c.Capabilities {
		if cap == "impersonate" {
			p.SharedIdentity = false
		}
	}
	return p
}

// HashToken returns the hex sha256 of a secret.
func HashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// RandomToken returns prefix + 32 random bytes base64url.
func RandomToken(prefix string) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

// CreateCluster inserts a cluster row.
func (s *Store) CreateCluster(ctx context.Context, name string) (*Cluster, error) {
	c := &Cluster{ID: uuid.NewString(), Name: name, Status: StatusPending, CreatedAt: time.Now().UTC(), Info: &kmatev1.ClusterInfo{Name: name}}
	_, err := s.db.ExecContext(ctx, `INSERT INTO clusters(id, name, status, cluster_info_json, created_at, capabilities_json, agent_token_hash) VALUES (?, ?, ?, ?, ?, '[]', '')`,
		c.ID, c.Name, c.Status, mustProtoJSON(c.Info), c.CreatedAt)
	if err != nil {
		return nil, err
	}
	return c, nil
}

// CreateEnrollmentToken issues a token for a cluster; returns the plaintext.
func (s *Store) CreateEnrollmentToken(ctx context.Context, clusterID string, ttl time.Duration) (string, error) {
	tok := RandomToken("kmt_enr_")
	_, err := s.db.ExecContext(ctx, `INSERT INTO enrollment_tokens(token_hash, cluster_id, expires_at) VALUES (?, ?, ?)`,
		HashToken(tok), clusterID, time.Now().UTC().Add(ttl))
	if err != nil {
		return "", err
	}
	return tok, nil
}

// ErrTokenInvalid is returned for unknown/expired enrollment tokens.
var ErrTokenInvalid = errors.New("store: enrollment token invalid or expired")

// ConsumeEnrollmentToken validates a token and marks it used. Tokens may be
// reused until expiry (so a restarted agent that lost its identity can
// re-enroll), but used_at is recorded for auditing.
func (s *Store) ConsumeEnrollmentToken(ctx context.Context, token string) (clusterID string, err error) {
	var expires time.Time
	err = s.db.QueryRowContext(ctx, `SELECT cluster_id, expires_at FROM enrollment_tokens WHERE token_hash = ?`, HashToken(token)).Scan(&clusterID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrTokenInvalid
	}
	if err != nil {
		return "", err
	}
	if time.Now().UTC().After(expires) {
		return "", ErrTokenInvalid
	}
	_, err = s.db.ExecContext(ctx, `UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ?`, time.Now().UTC(), HashToken(token))
	return clusterID, err
}

// SetAgentToken stores the hash of the agent bearer token.
func (s *Store) SetAgentToken(ctx context.Context, clusterID, token string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE clusters SET agent_token_hash = ? WHERE id = ?`, HashToken(token), clusterID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetCluster returns one cluster.
func (s *Store) GetCluster(ctx context.Context, id string) (*Cluster, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, status, cluster_info_json, last_heartbeat, created_at, capabilities_json, agent_token_hash FROM clusters WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cs, err := scanClusters(rows)
	if err != nil {
		return nil, err
	}
	if len(cs) == 0 {
		return nil, ErrNotFound
	}
	return cs[0], nil
}

// ListClusters returns all clusters.
func (s *Store) ListClusters(ctx context.Context) ([]*Cluster, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, status, cluster_info_json, last_heartbeat, created_at, capabilities_json, agent_token_hash FROM clusters ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanClusters(rows)
}

// DeleteCluster removes a cluster and dependent rows.
func (s *Store) DeleteCluster(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM clusters WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateClusterStatus sets status, optionally info/capabilities/heartbeat.
func (s *Store) UpdateClusterStatus(ctx context.Context, id, status string, info *kmatev1.ClusterInfo, caps []string, heartbeat *time.Time) error {
	if info != nil {
		capsJSON, _ := json.Marshal(caps)
		if caps == nil {
			capsJSON = []byte("[]")
		}
		if caps == nil {
			_, err := s.db.ExecContext(ctx, `UPDATE clusters SET status = ?, cluster_info_json = ?, last_heartbeat = ? WHERE id = ?`, status, mustProtoJSON(info), heartbeat, id)
			return err
		}
		_, err := s.db.ExecContext(ctx, `UPDATE clusters SET status = ?, cluster_info_json = ?, capabilities_json = ?, last_heartbeat = ? WHERE id = ?`, status, mustProtoJSON(info), string(capsJSON), heartbeat, id)
		return err
	}
	if heartbeat != nil {
		_, err := s.db.ExecContext(ctx, `UPDATE clusters SET status = ?, last_heartbeat = ? WHERE id = ?`, status, heartbeat, id)
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE clusters SET status = ? WHERE id = ?`, status, id)
	return err
}

// MarkAllOffline flips ONLINE clusters to OFFLINE (hub restart).
func (s *Store) MarkAllOffline(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE clusters SET status = ? WHERE status = ?`, StatusOffline, StatusOnline)
	return err
}

func scanClusters(rows *sql.Rows) ([]*Cluster, error) {
	var out []*Cluster
	for rows.Next() {
		var c Cluster
		var infoJSON, capsJSON string
		var hb sql.NullTime
		if err := rows.Scan(&c.ID, &c.Name, &c.Status, &infoJSON, &hb, &c.CreatedAt, &capsJSON, &c.AgentTokenHash); err != nil {
			return nil, err
		}
		c.Info = &kmatev1.ClusterInfo{}
		_ = protojson.Unmarshal([]byte(infoJSON), c.Info)
		if c.Info.Name == "" {
			c.Info.Name = c.Name
		}
		_ = json.Unmarshal([]byte(capsJSON), &c.Capabilities)
		if hb.Valid {
			t := hb.Time
			c.LastHeartbeat = &t
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

func mustProtoJSON(m *kmatev1.ClusterInfo) string {
	b, err := protojson.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(b)
}

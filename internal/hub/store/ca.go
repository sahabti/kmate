package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ErrNoCA is returned when the hub has not generated its root yet.
var ErrNoCA = errors.New("store: no hub CA")

// LoadCA returns the persisted root certificate and key.
func (s *Store) LoadCA(ctx context.Context) (certPEM, keyPEM []byte, err error) {
	var c, k string
	err = s.db.QueryRowContext(ctx, `SELECT cert_pem, key_pem FROM hub_ca WHERE id = 1`).Scan(&c, &k)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNoCA
	}
	if err != nil {
		return nil, nil, err
	}
	return []byte(c), []byte(k), nil
}

// SaveCA stores the root, refusing to overwrite an existing one: replacing the
// root would invalidate every certificate already issued to an agent.
func (s *Store) SaveCA(ctx context.Context, certPEM, keyPEM []byte) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO hub_ca(id, cert_pem, key_pem, created_at) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
		string(certPEM), string(keyPEM), time.Now().UTC())
	return err
}

// SetAgentCert records which certificate a cluster's agent currently holds.
func (s *Store) SetAgentCert(ctx context.Context, clusterID, serial string, expiry time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE clusters SET agent_cert_serial = ?, agent_cert_expiry = ? WHERE id = ?`,
		serial, expiry.UTC(), clusterID)
	return err
}

// AgentCert returns the serial and expiry of the cluster's current agent
// certificate. An empty serial means the agent has never been issued one.
func (s *Store) AgentCert(ctx context.Context, clusterID string) (serial string, expiry *time.Time, err error) {
	var exp sql.NullTime
	err = s.db.QueryRowContext(ctx, `SELECT agent_cert_serial, agent_cert_expiry FROM clusters WHERE id = ?`, clusterID).Scan(&serial, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	if exp.Valid {
		t := exp.Time.UTC()
		expiry = &t
	}
	return serial, expiry, nil
}

package ca

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
)

// Store is the persistence the manager needs. The hub's store satisfies it.
type Store interface {
	LoadCA(ctx context.Context) (certPEM, keyPEM []byte, err error)
	SaveCA(ctx context.Context, certPEM, keyPEM []byte) error
}

// ErrNoStoredCA is what a Store returns when no root has been generated yet.
// The manager treats any error whose message reports an absent CA the same way,
// so the store package does not have to import this one.
var ErrNoStoredCA = errors.New("ca: no stored root")

// LoadOrCreate returns the hub's root, generating and persisting one the first
// time. Generation is idempotent under a race: SaveCA does not overwrite, so a
// second caller reloads whichever root won.
func LoadOrCreate(ctx context.Context, st Store, log *slog.Logger) (*CA, error) {
	certPEM, keyPEM, err := st.LoadCA(ctx)
	if err == nil {
		c, lerr := Load(certPEM, keyPEM)
		if lerr != nil {
			return nil, fmt.Errorf("ca: stored root unusable: %w", lerr)
		}
		log.Info("hub CA loaded", "expires", c.NotAfter().Format("2006-01-02"))
		return c, nil
	}

	newCert, newKey, err := NewRoot()
	if err != nil {
		return nil, err
	}
	if err := st.SaveCA(ctx, newCert, newKey); err != nil {
		return nil, fmt.Errorf("ca: persist root: %w", err)
	}
	// Re-read: another replica may have won the insert, and every agent must
	// validate against the same root.
	certPEM, keyPEM, err = st.LoadCA(ctx)
	if err != nil {
		return nil, fmt.Errorf("ca: reload root after create: %w", err)
	}
	c, err := Load(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	log.Info("hub CA generated", "expires", c.NotAfter().Format("2006-01-02"))
	return c, nil
}

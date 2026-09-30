package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), "sqlite://"+filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestMigrations(t *testing.T) {
	s := openTest(t)
	names, err := s.AppliedMigrations(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(names) == 0 || names[0] != "0001_init.sql" {
		t.Fatalf("unexpected migrations %v", names)
	}
	// re-open is idempotent
	s2, err := Open(context.Background(), "sqlite://"+s.dbPath(t))
	if err != nil {
		t.Fatal(err)
	}
	s2.Close()
}

func (s *Store) dbPath(t *testing.T) string {
	var p string
	if err := s.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPostgresRejected(t *testing.T) {
	if _, err := Open(context.Background(), "postgres://x"); err == nil {
		t.Fatal("expected error")
	}
}

func TestEnrollmentLifecycle(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	c, err := s.CreateCluster(ctx, "prod")
	if err != nil {
		t.Fatal(err)
	}
	tok, err := s.CreateEnrollmentToken(ctx, c.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if tok[:8] != "kmt_enr_" {
		t.Fatalf("bad prefix %s", tok)
	}
	id, err := s.ConsumeEnrollmentToken(ctx, tok)
	if err != nil || id != c.ID {
		t.Fatalf("consume: %v %s", err, id)
	}
	if _, err := s.ConsumeEnrollmentToken(ctx, "kmt_enr_nope"); err != ErrTokenInvalid {
		t.Fatalf("expected invalid, got %v", err)
	}
	exp, _ := s.CreateEnrollmentToken(ctx, c.ID, -time.Minute)
	if _, err := s.ConsumeEnrollmentToken(ctx, exp); err != ErrTokenInvalid {
		t.Fatalf("expected expired, got %v", err)
	}
	if err := s.SetAgentToken(ctx, c.ID, "agent-secret"); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetCluster(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.AgentTokenHash != HashToken("agent-secret") {
		t.Fatal("agent token hash mismatch")
	}
	now := time.Now().UTC()
	if err := s.UpdateClusterStatus(ctx, c.ID, StatusOnline, &kmatev1.ClusterInfo{Name: "prod", NodeCount: 3}, []string{"read"}, &now); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetCluster(ctx, c.ID)
	if got.Status != StatusOnline || got.Info.NodeCount != 3 || len(got.Capabilities) != 1 || got.LastHeartbeat == nil {
		t.Fatalf("status update not persisted: %+v", got)
	}
	if err := s.SaveCatalog(ctx, c.ID, &kmatev1.Catalog{Version: 7}); err != nil {
		t.Fatal(err)
	}
	cat, err := s.GetCatalog(ctx, c.ID)
	if err != nil || cat.Version != 7 {
		t.Fatalf("catalog: %v %v", err, cat)
	}
	if err := s.DeleteCluster(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCatalog(ctx, c.ID); err != ErrNotFound {
		t.Fatalf("catalog should cascade, got %v", err)
	}
}

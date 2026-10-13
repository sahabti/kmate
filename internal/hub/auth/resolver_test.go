package auth

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type racingDirectory struct {
	entered, resume chan struct{}
	reads           atomic.Int32
}

type invalidatingDirectory struct {
	invalidate    func()
	invalidations int
	reads         int
}

func (d *invalidatingDirectory) AuthRecord(context.Context, string) (*Record, error) {
	d.reads++
	if d.reads <= d.invalidations {
		d.invalidate()
	}
	return &Record{ID: "u", Active: true, Role: RoleViewer}, nil
}

func (d *invalidatingDirectory) AuthGrants(context.Context, string) ([]Grant, error) {
	return nil, nil
}

func TestResolutionRetriesAreBounded(t *testing.T) {
	for _, tc := range []struct {
		name          string
		invalidations int
		wantReads     int
		wantError     bool
	}{
		{"stable", 0, 1, false},
		{"one invalidation", 1, 2, false},
		{"two invalidations", 2, 3, false},
		{"continuous invalidation", 1000, resolveAttempts, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &invalidatingDirectory{invalidations: tc.invalidations}
			a := New([]byte("secret")).WithDirectory(d)
			d.invalidate = func() { a.Invalidate("u") }
			rec, _, err := a.res.get(context.Background(), "u")
			if tc.wantError {
				if !errors.Is(err, errResolutionChanged) || rec != nil {
					t.Fatalf("unstable resolution must fail closed: rec=%v err=%v", rec, err)
				}
				if len(a.res.m) != 0 {
					t.Fatal("unstable snapshot was cached")
				}
			} else if err != nil || rec == nil {
				t.Fatalf("stable resolution failed: %v", err)
			}
			if d.reads != tc.wantReads {
				t.Fatalf("directory reads=%d, want %d", d.reads, tc.wantReads)
			}
		})
	}
}

func TestResolutionHonorsCanceledContext(t *testing.T) {
	d := &invalidatingDirectory{}
	a := New([]byte("secret")).WithDirectory(d)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := a.res.get(ctx, "u"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	if d.reads != 0 {
		t.Fatal("canceled resolution queried the directory")
	}
}

func (d *racingDirectory) AuthRecord(context.Context, string) (*Record, error) {
	role := RoleViewer
	if d.reads.Add(1) == 1 {
		close(d.entered)
		<-d.resume
		role = RoleAdmin
	}
	return &Record{ID: "u", Active: true, Role: role}, nil
}
func (d *racingDirectory) AuthGrants(context.Context, string) ([]Grant, error) { return nil, nil }

func TestInvalidationRejectsInflightStaleResolution(t *testing.T) {
	d := &racingDirectory{entered: make(chan struct{}), resume: make(chan struct{})}
	a := New([]byte("secret")).WithDirectory(d)
	result := make(chan *Principal, 1)
	go func() {
		p, err := a.hydrate(context.Background(), &Principal{ID: "u"})
		if err != nil {
			t.Error(err)
		}
		result <- p
	}()
	select {
	case <-d.entered:
	case <-time.After(time.Second):
		t.Fatal("directory read did not start")
	}
	a.Invalidate("u")
	close(d.resume)
	select {
	case p := <-result:
		if p == nil || p.Role != RoleViewer {
			t.Fatalf("stale role was reinstated: %v", p)
		}
	case <-time.After(time.Second):
		t.Fatal("resolution did not finish")
	}
}

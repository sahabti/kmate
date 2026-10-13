package auth

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type racingDirectory struct {
	entered, resume chan struct{}
	reads           atomic.Int32
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

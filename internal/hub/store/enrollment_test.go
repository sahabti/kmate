package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// An enrolment token must work exactly once. Before this was enforced, a leaked
// token let anyone stand up a rogue agent for that cluster for a whole day, and
// the registry would hand it every client request for the cluster it displaced.
func TestEnrollmentTokenIsSingleUse(t *testing.T) {
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

	got, err := s.ConsumeEnrollmentToken(ctx, tok)
	if err != nil || got != c.ID {
		t.Fatalf("first use: got %q, %v; want %q, nil", got, err, c.ID)
	}
	if _, err := s.ConsumeEnrollmentToken(ctx, tok); !errors.Is(err, ErrTokenUsed) {
		t.Fatalf("second use: got %v; want ErrTokenUsed", err)
	}
}

// Two agents racing with the same token must not both enrol.
func TestEnrollmentTokenRaceYieldsOneWinner(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	c, _ := s.CreateCluster(ctx, "race")
	tok, err := s.CreateEnrollmentToken(ctx, c.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	const n = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			if _, err := s.ConsumeEnrollmentToken(ctx, tok); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("concurrent enrolments succeeded %d times; want exactly 1", wins)
	}
}

func TestEnrollmentTokenExpires(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	c, _ := s.CreateCluster(ctx, "stale")
	tok, err := s.CreateEnrollmentToken(ctx, c.ID, -time.Minute) // already expired
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumeEnrollmentToken(ctx, tok); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("expired token: got %v; want ErrTokenInvalid", err)
	}
}

func TestUnknownEnrollmentTokenRejected(t *testing.T) {
	s := openTest(t)
	if _, err := s.ConsumeEnrollmentToken(context.Background(), "kmt_enr_nope"); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("unknown token: got %v; want ErrTokenInvalid", err)
	}
}

// Issuing a replacement invalidates the outstanding one, so only ever one token
// per cluster is live. Otherwise "rotating" a leaked token would not revoke it.
func TestIssuingReplacementInvalidatesPrevious(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	c, _ := s.CreateCluster(ctx, "rotate")
	old, err := s.CreateEnrollmentToken(ctx, c.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := s.CreateEnrollmentToken(ctx, c.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if old == fresh {
		t.Fatal("replacement token is identical to the previous one")
	}
	if _, err := s.ConsumeEnrollmentToken(ctx, old); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("superseded token: got %v; want ErrTokenInvalid", err)
	}
	if got, err := s.ConsumeEnrollmentToken(ctx, fresh); err != nil || got != c.ID {
		t.Fatalf("replacement token: got %q, %v; want %q, nil", got, err, c.ID)
	}
}

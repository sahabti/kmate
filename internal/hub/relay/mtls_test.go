package relay

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/ca"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/store"
)

func testRelay(t *testing.T, mode MTLSMode) (*Relay, *store.Store, *ca.CA) {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, "sqlite://"+filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	authority, err := ca.LoadOrCreate(ctx, st, slog.New(slog.NewTextHandler(discard{}, nil)))
	if err != nil {
		t.Fatal(err)
	}
	r := New(st, registry.New(), slog.New(slog.NewTextHandler(discard{}, nil))).WithCA(authority, mode)
	return r, st, authority
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func TestParseMTLSMode(t *testing.T) {
	cases := map[string]MTLSMode{
		"off": MTLSOff, "none": MTLSOff, "false": MTLSOff,
		"required": MTLSRequired, "require": MTLSRequired, "strict": MTLSRequired,
		"optional": MTLSOptional, "": MTLSOptional, "nonsense": MTLSOptional,
		"  REQUIRED  ": MTLSRequired,
	}
	for in, want := range cases {
		if got := ParseMTLSMode(in); got != want {
			t.Errorf("ParseMTLSMode(%q) = %q, want %q", in, got, want)
		}
	}
}

// A certificate is the stronger claim: the agent is attributed to the cluster
// the hub named in it, whatever its Hello says.
func TestCertificateIdentifiesTheCluster(t *testing.T) {
	ctx := context.Background()
	r, st, _ := testRelay(t, MTLSOptional)
	cl, err := st.CreateCluster(ctx, "prod")
	if err != nil {
		t.Fatal(err)
	}
	peer := ca.Identity{ClusterID: cl.ID, AgentID: "agent-1"}

	got, err := r.authenticateAgent(ctx, &kmatev1.Hello{ClusterId: cl.ID}, peer, true)
	if err != nil {
		t.Fatalf("authenticate with certificate: %v", err)
	}
	if got.ID != cl.ID {
		t.Errorf("cluster = %s, want %s", got.ID, cl.ID)
	}
	// No bearer token was supplied, and none was needed.
	if _, err := r.authenticateAgent(ctx, &kmatev1.Hello{}, peer, true); err != nil {
		t.Errorf("certificate alone should authenticate: %v", err)
	}
}

func TestCertificateForAnotherClusterIsRejected(t *testing.T) {
	ctx := context.Background()
	r, st, _ := testRelay(t, MTLSOptional)
	a, _ := st.CreateCluster(ctx, "a")
	b, _ := st.CreateCluster(ctx, "b")

	// Certificate says cluster A, Hello claims cluster B.
	_, err := r.authenticateAgent(ctx, &kmatev1.Hello{ClusterId: b.ID}, ca.Identity{ClusterID: a.ID}, true)
	if err == nil {
		t.Fatal("expected a mismatched certificate to be refused")
	}
	if got := err.Error(); !contains(got, "does not match") {
		t.Errorf("unhelpful error: %v", got)
	}
}

func TestCertificateForUnknownClusterIsRejected(t *testing.T) {
	ctx := context.Background()
	r, _, _ := testRelay(t, MTLSOptional)
	if _, err := r.authenticateAgent(ctx, &kmatev1.Hello{}, ca.Identity{ClusterID: "nope"}, true); err == nil {
		t.Error("expected a certificate naming an unknown cluster to be refused")
	}
}

// The three modes differ only in how they treat an agent with no certificate.
func TestModesAndTokenOnlyAgents(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		mode      MTLSMode
		wantAllow bool
	}{
		{MTLSOff, true},
		{MTLSOptional, true},
		{MTLSRequired, false},
	} {
		r, st, _ := testRelay(t, tc.mode)
		cl, _ := st.CreateCluster(ctx, "c")
		tok := store.RandomToken("kmt_agt_")
		if err := st.SetAgentToken(ctx, cl.ID, tok); err != nil {
			t.Fatal(err)
		}
		_, err := r.authenticateAgent(ctx, &kmatev1.Hello{AgentToken: tok}, ca.Identity{}, false)
		if tc.wantAllow && err != nil {
			t.Errorf("mode %s: token-only agent should connect: %v", tc.mode, err)
		}
		if !tc.wantAllow {
			if err == nil {
				t.Errorf("mode %s: token-only agent should be refused", tc.mode)
			} else if !contains(err.Error(), "requires agent mTLS") {
				t.Errorf("mode %s: unhelpful refusal: %v", tc.mode, err)
			}
		}
	}
}

func TestBadTokenIsRejected(t *testing.T) {
	ctx := context.Background()
	r, st, _ := testRelay(t, MTLSOptional)
	if _, err := st.CreateCluster(ctx, "c"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.authenticateAgent(ctx, &kmatev1.Hello{AgentToken: "kmt_agt_wrong"}, ca.Identity{}, false); err == nil {
		t.Error("expected an unknown token to be refused")
	}
	if _, err := r.authenticateAgent(ctx, &kmatev1.Hello{}, ca.Identity{}, false); err == nil {
		t.Error("expected a missing token to be refused")
	}
}

// Enrolment signs the CSR the agent supplies and keeps its key private.
func TestEnrollIssuesCertificateFromCSR(t *testing.T) {
	ctx := context.Background()
	r, st, authority := testRelay(t, MTLSOptional)
	cl, _ := st.CreateCluster(ctx, "c")
	tok, err := st.CreateEnrollmentToken(ctx, cl.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	csr := mustCSR(t)
	resp, err := r.Enroll(ctx, &kmatev1.EnrollRequest{EnrollmentToken: tok, CsrPem: csr})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.CertPem) == 0 {
		t.Fatal("no certificate issued")
	}
	if len(resp.KeyPem) != 0 {
		t.Error("the hub returned a private key even though the agent sent a CSR")
	}
	if string(resp.CaPem) != string(authority.CertPEM()) {
		t.Error("the CA returned does not match the hub root")
	}
	id, ok := ca.IdentityFromCert(mustParse(t, resp.CertPem))
	if !ok || id.ClusterID != cl.ID {
		t.Errorf("certificate names %q, want %s", id.ClusterID, cl.ID)
	}
	// The expiry is recorded so operators can see what is about to lapse.
	serial, expiry, err := st.AgentCert(ctx, cl.ID)
	if err != nil {
		t.Fatal(err)
	}
	if serial == "" || expiry == nil {
		t.Error("the issued certificate was not recorded against the cluster")
	}
}

// With no CSR the hub generates the key, which keeps simple deployments working.
func TestEnrollWithoutCSRReturnsAKey(t *testing.T) {
	ctx := context.Background()
	r, st, _ := testRelay(t, MTLSOptional)
	cl, _ := st.CreateCluster(ctx, "c")
	tok, _ := st.CreateEnrollmentToken(ctx, cl.ID, time.Hour)
	resp, err := r.Enroll(ctx, &kmatev1.EnrollRequest{EnrollmentToken: tok})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.CertPem) == 0 || len(resp.KeyPem) == 0 {
		t.Error("expected both a certificate and a key when no CSR is sent")
	}
}

// With mTLS off, enrolment still works and simply issues no certificate.
func TestEnrollWithMTLSOffIssuesNoCert(t *testing.T) {
	ctx := context.Background()
	r, st, _ := testRelay(t, MTLSOff)
	cl, _ := st.CreateCluster(ctx, "c")
	tok, _ := st.CreateEnrollmentToken(ctx, cl.ID, time.Hour)
	resp, err := r.Enroll(ctx, &kmatev1.EnrollRequest{EnrollmentToken: tok, CsrPem: mustCSR(t)})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.CertPem) != 0 {
		t.Error("expected no certificate when mTLS is off")
	}
	if resp.AgentToken == "" {
		t.Error("the bearer token is still required when mTLS is off")
	}
}

// The root survives a restart, so certificates already issued keep validating.
func TestCAPersistsAcrossReload(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(discard{}, nil))

	st1, err := store.Open(ctx, "sqlite://"+filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := ca.LoadOrCreate(ctx, st1, log)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := first.SignCSR(mustCSR(t), "cluster-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	st1.Close()

	st2, err := store.Open(ctx, "sqlite://"+filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	second, err := ca.LoadOrCreate(ctx, st2, log)
	if err != nil {
		t.Fatal(err)
	}
	if string(first.CertPEM()) != string(second.CertPEM()) {
		t.Fatal("the hub generated a new root on restart; every agent would have to re-enroll")
	}
	if _, err := verifyAgainst(leaf, second); err != nil {
		t.Errorf("a certificate issued before restart no longer verifies: %v", err)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

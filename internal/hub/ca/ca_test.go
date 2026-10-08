package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"testing"
	"time"
)

func newTestCA(t *testing.T) *CA {
	t.Helper()
	certPEM, keyPEM, err := NewRoot()
	if err != nil {
		t.Fatalf("NewRoot: %v", err)
	}
	c, err := Load(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

func testCSR(t *testing.T, cn string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader,
		&x509.CertificateRequest{Subject: pkix.Name{CommonName: cn}, SignatureAlgorithm: x509.ECDSAWithSHA256}, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
}

func parse(t *testing.T, certPEM []byte) *x509.Certificate {
	t.Helper()
	b, _ := pem.Decode(certPEM)
	if b == nil {
		t.Fatal("not PEM")
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRootIsCAAndLongLived(t *testing.T) {
	c := newTestCA(t)
	root := parse(t, c.CertPEM())
	if !root.IsCA {
		t.Error("root is not a CA")
	}
	if got := time.Until(root.NotAfter); got < 9*365*24*time.Hour {
		t.Errorf("root life too short: %v", got)
	}
}

func TestLoadRoundTrips(t *testing.T) {
	certPEM, keyPEM, err := NewRoot()
	if err != nil {
		t.Fatal(err)
	}
	c, err := Load(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if string(c.CertPEM()) != string(certPEM) {
		t.Error("CertPEM did not round trip")
	}
	// A reloaded CA must still issue certificates the original root verifies.
	leaf, err := c.SignCSR(testCSR(t, "x"), "cluster-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parse(t, leaf).Verify(x509.VerifyOptions{Roots: c.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Errorf("leaf from reloaded CA does not verify: %v", err)
	}
}

func TestSignCSRIssuesVerifiableClientCert(t *testing.T) {
	c := newTestCA(t)
	certPEM, err := c.SignCSR(testCSR(t, "ignored"), "cluster-1", "agent-1")
	if err != nil {
		t.Fatalf("SignCSR: %v", err)
	}
	leaf := parse(t, certPEM)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: c.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Errorf("leaf does not verify against the root: %v", err)
	}
	if leaf.IsCA {
		t.Error("leaf must not be a CA")
	}
	if got := leaf.NotAfter.Sub(leaf.NotBefore); got > LeafLifetime+10*time.Minute {
		t.Errorf("leaf life %v exceeds %v", got, LeafLifetime)
	}
}

func TestSignedCertCarriesIdentityNotCSRSubject(t *testing.T) {
	c := newTestCA(t)
	// The CSR asks to be someone else; the hub must ignore that entirely.
	certPEM, err := c.SignCSR(testCSR(t, "attacker-cluster"), "cluster-real", "agent-real")
	if err != nil {
		t.Fatal(err)
	}
	id, ok := IdentityFromCert(parse(t, certPEM))
	if !ok {
		t.Fatal("no identity in certificate")
	}
	if id.ClusterID != "cluster-real" {
		t.Errorf("cluster id = %q, want cluster-real (CSR subject must not win)", id.ClusterID)
	}
	if id.AgentID != "agent-real" {
		t.Errorf("agent id = %q, want agent-real", id.AgentID)
	}
}

func TestSignCSRRejectsGarbage(t *testing.T) {
	c := newTestCA(t)
	for name, in := range map[string][]byte{
		"empty":       nil,
		"not pem":     []byte("hello"),
		"wrong block": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1, 2, 3}}),
	} {
		if _, err := c.SignCSR(in, "c", "a"); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestSignRequiresClusterID(t *testing.T) {
	c := newTestCA(t)
	if _, err := c.SignCSR(testCSR(t, "x"), "", "agent"); err == nil {
		t.Error("expected an error when no cluster id is supplied")
	}
}

func TestForeignCertDoesNotVerify(t *testing.T) {
	// A certificate from a different hub must not be accepted by this one.
	ours, theirs := newTestCA(t), newTestCA(t)
	foreign, err := theirs.SignCSR(testCSR(t, "x"), "cluster-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parse(t, foreign).Verify(x509.VerifyOptions{Roots: ours.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err == nil {
		t.Error("a certificate from another CA verified against ours")
	}
}

func TestIssueWithGeneratedKey(t *testing.T) {
	c := newTestCA(t)
	certPEM, keyPEM, err := c.IssueWithGeneratedKey("cluster-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(keyPEM) == 0 {
		t.Fatal("no key returned")
	}
	// The pair must actually match, or the agent cannot use it.
	if _, err := tlsPair(certPEM, keyPEM); err != nil {
		t.Errorf("issued pair does not load: %v", err)
	}
}

func TestIdentityFromCertRejectsUnrelated(t *testing.T) {
	// A certificate with no KMate SANs and no CN carries no usable identity.
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: bigOne(), Subject: pkix.Name{Organization: []string{"other"}}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	if _, ok := IdentityFromCert(c); ok {
		t.Error("expected no identity from an unrelated certificate")
	}
	if _, ok := IdentityFromCert(nil); ok {
		t.Error("expected no identity from a nil certificate")
	}
}

func TestNeedsRenewalAtTwoThirds(t *testing.T) {
	start := time.Now()
	end := start.Add(30 * 24 * time.Hour)
	cases := []struct {
		name string
		at   time.Time
		want bool
	}{
		{"fresh", start.Add(time.Hour), false},
		{"halfway", start.Add(15 * 24 * time.Hour), false},
		{"just before threshold", start.Add(19 * 24 * time.Hour), false},
		{"past threshold", start.Add(21 * 24 * time.Hour), true},
		{"expired", end.Add(time.Hour), true},
	}
	for _, tc := range cases {
		if got := NeedsRenewal(start, end, tc.at); got != tc.want {
			t.Errorf("%s: NeedsRenewal = %v, want %v", tc.name, got, tc.want)
		}
	}
	// A zero-length window is always due, rather than dividing by zero.
	if !NeedsRenewal(start, start, start) {
		t.Error("a zero-length certificate should be due for renewal")
	}
}

func TestNilCARefusesToSign(t *testing.T) {
	var c *CA
	if _, err := c.SignCSR(testCSR(t, "x"), "c", "a"); err == nil {
		t.Error("a nil CA must not sign")
	}
	if _, _, err := c.IssueWithGeneratedKey("c", "a"); err == nil {
		t.Error("a nil CA must not issue")
	}
}

// Rotation must produce a genuinely different certificate, not the same one
// re-encoded, or an exposed key would stay valid after renewal.
func TestRotationIssuesADistinctCertificate(t *testing.T) {
	c := newTestCA(t)
	first, err := c.SignCSR(testCSR(t, "x"), "cluster-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.SignCSR(testCSR(t, "x"), "cluster-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	a, b := parse(t, first), parse(t, second)
	if a.SerialNumber.Cmp(b.SerialNumber) == 0 {
		t.Error("renewal reused the serial number")
	}
	if string(first) == string(second) {
		t.Error("renewal returned an identical certificate")
	}
	// Both must still verify: the old one stays usable until it expires, so a
	// rotating agent is never locked out mid-flight.
	for name, cert := range map[string][]byte{"first": first, "second": second} {
		if _, err := parse(t, cert).Verify(x509.VerifyOptions{Roots: c.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
			t.Errorf("%s certificate does not verify: %v", name, err)
		}
	}
}

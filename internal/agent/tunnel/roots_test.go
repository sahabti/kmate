package tunnel

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

// selfSignedCA returns a CA certificate in PEM form, standing in for the CA the
// hub issues to an agent at enrollment.
func selfSignedCA(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "kmate-test-hub-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestRootsWithHubCAKeepsSystemRoots(t *testing.T) {
	caPEM := selfSignedCA(t)

	got := rootsWithHubCA(caPEM)
	if got == nil {
		t.Fatal("nil pool")
	}

	// The regression this guards: building a pool that holds ONLY the hub's CA.
	// A hub behind an ingress gateway or CDN presents a publicly signed
	// certificate, and an agent that trusts only the hub CA rejects it as an
	// unknown authority, then retries forever while the cluster shows offline.
	onlyHubCA := x509.NewCertPool()
	if !onlyHubCA.AppendCertsFromPEM(caPEM) {
		t.Fatal("test CA did not parse")
	}
	if got.Equal(onlyHubCA) {
		t.Error("pool contains only the hub CA; the system roots were replaced instead of extended")
	}

	if sys, err := x509.SystemCertPool(); err == nil && sys != nil {
		if got.Equal(sys) {
			t.Error("hub CA was not added to the pool")
		}
	}
}

func TestRootsWithHubCAHandlesUnparseablePEM(t *testing.T) {
	// A corrupt CA must not produce a nil pool: falling back to the system roots
	// still lets the agent reach a hub behind a public certificate.
	if got := rootsWithHubCA([]byte("not a certificate")); got == nil {
		t.Fatal("nil pool for unparseable CA")
	}
}

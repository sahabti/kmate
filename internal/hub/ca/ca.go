// Package ca is the hub's internal certificate authority. It issues the client
// certificates agents use for mutual TLS on the agent listener.
//
// The root is generated once on first start and persisted by the hub's store, so
// certificates issued to agents keep validating across restarts. Leaf
// certificates are short lived (30 days) and the agent renews them over its
// existing tunnel, which means a compromised agent certificate ages out quickly
// without anyone re-running an install.
package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"time"
)

const (
	// RootLifetime is deliberately long: rotating the root means re-enrolling
	// every agent, so it should outlive any realistic deployment.
	RootLifetime = 10 * 365 * 24 * time.Hour
	// LeafLifetime is short because renewal is automatic over the tunnel.
	LeafLifetime = 30 * 24 * time.Hour
	// RenewAfter is the fraction of a leaf's life after which the agent renews.
	RenewAfter = 2.0 / 3.0

	orgName = "KMate"
)

var (
	// ErrNoCA is returned when signing is attempted before a root exists.
	ErrNoCA = errors.New("ca: no root certificate loaded")
	// ErrBadCSR is returned for a malformed or unverifiable signing request.
	ErrBadCSR = errors.New("ca: invalid certificate signing request")
)

// CA is a loaded root certificate and its key. It is safe for concurrent use:
// all fields are read-only after construction.
type CA struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	certPEM []byte
}

// NewRoot generates a fresh root CA. The caller is responsible for persisting
// the returned PEM blocks; the key must never be logged or served.
func NewRoot() (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("ca: generate root key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now().UTC()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{Organization: []string{orgName}, CommonName: "KMate Agent CA"},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(RootLifetime),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("ca: self-sign root: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("ca: marshal root key: %w", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

// Load reconstructs a CA from persisted PEM.
func Load(certPEM, keyPEM []byte) (*CA, error) {
	cb, _ := pem.Decode(certPEM)
	if cb == nil || cb.Type != "CERTIFICATE" {
		return nil, errors.New("ca: root certificate PEM is not a CERTIFICATE block")
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return nil, fmt.Errorf("ca: parse root certificate: %w", err)
	}
	kb, _ := pem.Decode(keyPEM)
	if kb == nil {
		return nil, errors.New("ca: root key PEM is empty")
	}
	key, err := x509.ParseECPrivateKey(kb.Bytes)
	if err != nil {
		return nil, fmt.Errorf("ca: parse root key: %w", err)
	}
	return &CA{cert: cert, key: key, certPEM: certPEM}, nil
}

// CertPEM returns the root certificate, which is safe to hand to agents.
func (c *CA) CertPEM() []byte { return c.certPEM }

// Pool returns a verification pool containing the root.
func (c *CA) Pool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AppendCertsFromPEM(c.certPEM)
	return p
}

// NotAfter reports when the root expires.
func (c *CA) NotAfter() time.Time { return c.cert.NotAfter }

// SignCSR issues a client certificate for one agent. The identity in the CSR's
// subject is ignored: cluster and agent id come from the enrollment the hub just
// validated, so an agent cannot ask for a certificate naming a different cluster.
func (c *CA) SignCSR(csrPEM []byte, clusterID, agentID string) ([]byte, error) {
	if c == nil || c.key == nil {
		return nil, ErrNoCA
	}
	b, _ := pem.Decode(csrPEM)
	if b == nil || b.Type != "CERTIFICATE REQUEST" {
		return nil, ErrBadCSR
	}
	csr, err := x509.ParseCertificateRequest(b.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadCSR, err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("%w: signature: %v", ErrBadCSR, err)
	}
	return c.issue(csr.PublicKey, clusterID, agentID)
}

// SignPublicKey issues a certificate for a public key the hub generated itself.
// Used only for the dev path where the agent sends no CSR.
func (c *CA) SignPublicKey(pub any, clusterID, agentID string) ([]byte, error) {
	if c == nil || c.key == nil {
		return nil, ErrNoCA
	}
	return c.issue(pub, clusterID, agentID)
}

// IssueWithGeneratedKey creates a keypair and certificate together, for agents
// that cannot generate a CSR. The private key crosses the wire, so this is the
// weaker path and is only used when the agent sends no CSR.
func (c *CA) IssueWithGeneratedKey(clusterID, agentID string) (certPEM, keyPEM []byte, err error) {
	if c == nil || c.key == nil {
		return nil, nil, ErrNoCA
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("ca: generate leaf key: %w", err)
	}
	certPEM, err = c.issue(&key.PublicKey, clusterID, agentID)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("ca: marshal leaf key: %w", err)
	}
	return certPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
}

// issue signs a leaf naming the cluster and agent. The cluster id is the common
// name and both ids are URI SANs, so the listener can identify the peer without
// trusting anything the agent says in its Hello.
func (c *CA) issue(pub any, clusterID, agentID string) ([]byte, error) {
	if clusterID == "" {
		return nil, errors.New("ca: cluster id required")
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization:       []string{orgName},
			OrganizationalUnit: []string{"agent"},
			CommonName:         clusterID,
		},
		NotBefore:   now.Add(-5 * time.Minute),
		NotAfter:    now.Add(LeafLifetime),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		URIs:        identityURIs(clusterID, agentID),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, pub, c.key)
	if err != nil {
		return nil, fmt.Errorf("ca: sign leaf: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), nil
}

// Identity is what a verified client certificate tells the hub about its peer.
type Identity struct {
	ClusterID string
	AgentID   string
	NotAfter  time.Time
}

// IdentityFromCert extracts the cluster and agent ids the hub put in a leaf.
func IdentityFromCert(cert *x509.Certificate) (Identity, bool) {
	if cert == nil {
		return Identity{}, false
	}
	id := Identity{ClusterID: cert.Subject.CommonName, NotAfter: cert.NotAfter}
	for _, u := range cert.URIs {
		if u == nil || u.Scheme != uriScheme {
			continue
		}
		switch u.Host {
		case "cluster":
			id.ClusterID = trimPath(u.Path)
		case "agent":
			id.AgentID = trimPath(u.Path)
		}
	}
	if id.ClusterID == "" {
		return Identity{}, false
	}
	return id, true
}

// NeedsRenewal reports whether a leaf has passed the renewal threshold.
func NeedsRenewal(notBefore, notAfter time.Time, now time.Time) bool {
	life := notAfter.Sub(notBefore)
	if life <= 0 {
		return true
	}
	return now.After(notBefore.Add(time.Duration(float64(life) * RenewAfter)))
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	n, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("ca: serial: %w", err)
	}
	return n, nil
}

func trimPath(p string) string {
	for len(p) > 0 && p[0] == '/' {
		p = p[1:]
	}
	return p
}

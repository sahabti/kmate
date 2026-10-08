package tunnel

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/ca"
	"github.com/kmate-dev/kmate/internal/mux"
)

// newCSR generates a fresh keypair and a signing request for it. The key is
// returned to the caller and never sent to the hub, so only the agent ever holds
// the private half of its own identity.
func newCSR(clusterName string) (csrPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate agent key: %w", err)
	}
	// The subject is advisory: the hub names the certificate from the enrolment
	// it just validated, not from anything claimed here.
	tmpl := &x509.CertificateRequest{
		Subject:            pkix.Name{CommonName: clusterName, Organization: []string{"KMate"}},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		return nil, nil, fmt.Errorf("create CSR: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal agent key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), nil
}

// certWindow reports the validity window of the stored certificate.
func certWindow(certPEM []byte) (notBefore, notAfter time.Time, ok bool) {
	b, _ := pem.Decode(certPEM)
	if b == nil {
		return time.Time{}, time.Time{}, false
	}
	crt, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	return crt.NotBefore, crt.NotAfter, true
}

// CertExpiry returns when the stored certificate runs out, for metrics and
// warnings. A zero time means the agent holds no certificate and is
// authenticating with its bearer token.
func (c *Client) CertExpiry() time.Time {
	if c.identity == nil || len(c.identity.CertPEM) == 0 {
		return time.Time{}
	}
	_, notAfter, ok := certWindow(c.identity.CertPEM)
	if !ok {
		return time.Time{}
	}
	return notAfter
}

// renewLoop watches the stored certificate and asks the hub for a new one once
// it passes two thirds of its life. Renewal runs over the established tunnel, so
// it needs no enrolment token and no human.
func (c *Client) renewLoop(ctx context.Context, sess *mux.Session) {
	t := time.NewTicker(renewCheckEvery)
	defer t.Stop()
	// Check once shortly after connecting so a bearer-only agent picks up a
	// certificate promptly instead of waiting out the first tick.
	select {
	case <-ctx.Done():
		return
	case <-sess.Done():
		return
	case <-time.After(10 * time.Second):
		c.maybeRenew(ctx, sess)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-sess.Done():
			return
		case <-t.C:
			c.maybeRenew(ctx, sess)
		}
	}
}

func (c *Client) maybeRenew(ctx context.Context, sess *mux.Session) {
	if c.identity == nil || c.cfg.Insecure {
		return
	}
	// An agent that enrolled before this hub issued certificates holds only a
	// bearer token. It can obtain its first certificate over the tunnel it is
	// already authenticated on, so upgrading a fleet needs no new enrolment
	// tokens and no redeploy.
	if len(c.identity.CertPEM) == 0 {
		if err := c.renewCert(ctx, sess); err != nil {
			c.log.Debug("hub issued no certificate yet", "err", err)
		} else {
			c.log.Info("obtained first agent certificate; mTLS active on next reconnect")
		}
		return
	}
	notBefore, notAfter, ok := certWindow(c.identity.CertPEM)
	if !ok {
		return
	}
	now := time.Now()
	if !ca.NeedsRenewal(notBefore, notAfter, now) {
		return
	}
	left := time.Until(notAfter)
	if left < 7*24*time.Hour {
		c.log.Warn("agent certificate expiring soon", "expires", notAfter.Format(time.RFC3339), "in", left.Round(time.Hour))
	}
	if err := c.renewCert(ctx, sess); err != nil {
		c.log.Warn("certificate renewal failed; will retry", "err", err)
	}
}

// renewCert performs one renewal round trip on an agent-initiated stream.
func (c *Client) renewCert(ctx context.Context, sess *mux.Session) error {
	csrPEM, keyPEM, err := newCSR(c.clusterName())
	if err != nil {
		return err
	}
	st, err := sess.Open()
	if err != nil {
		return err
	}
	defer st.Close(nil)
	if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_CertRenewal{
		CertRenewal: &kmatev1.CertRenewalRequest{CsrPem: csrPEM},
	}}); err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	f, err := st.Recv(rctx)
	if err != nil {
		return err
	}
	resp := f.GetCertRenewed()
	if resp == nil {
		return fmt.Errorf("unexpected reply to renewal")
	}
	if e := resp.GetError(); e != nil {
		return fmt.Errorf("hub refused renewal: %s", e.GetMessage())
	}
	if len(resp.GetCertPem()) == 0 {
		return fmt.Errorf("hub returned an empty certificate")
	}

	// Swap in the new pair only once it parses, so a bad reply cannot strand the
	// agent without a usable identity.
	next := *c.identity
	next.CertPEM = resp.GetCertPem()
	next.KeyPEM = keyPEM
	if len(resp.GetCaPem()) > 0 {
		next.CAPEM = resp.GetCaPem()
	}
	if _, _, ok := certWindow(next.CertPEM); !ok {
		return fmt.Errorf("hub returned an unparseable certificate")
	}
	c.identity = &next
	if err := c.store.Save(ctx, c.identity); err != nil {
		c.log.Warn("persisting renewed certificate failed", "err", err)
	}
	_, notAfter, _ := certWindow(next.CertPEM)
	c.log.Info("agent certificate renewed", "expires", notAfter.Format(time.RFC3339))
	// The new certificate takes effect on the next dial; the current tunnel keeps
	// running on the old one until it reconnects naturally, so no client session
	// is interrupted by rotation.
	return nil
}

func (c *Client) clusterName() string {
	if c.clients != nil && c.clients.ClusterName != "" {
		return c.clients.ClusterName
	}
	if c.identity != nil && c.identity.ClusterID != "" {
		return c.identity.ClusterID
	}
	return "kmate-agent"
}

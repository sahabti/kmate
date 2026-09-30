// Package ca will hold the hub's internal certificate authority used to issue
// agent client certificates for mTLS (phase 5).
//
// TODO(phase 5): generate a root CA on first start (persist in the store),
// sign CSRs from EnrollRequest.csr_pem, rotate at 2/3 lifetime over the tunnel,
// and require client certs on the agent listener. Until then agents
// authenticate with the bearer agent_token issued at enrollment.
package ca

import "errors"

// ErrNotImplemented is returned by all CA operations until phase 5.
var ErrNotImplemented = errors.New("ca: mTLS certificate issuance not implemented yet (phase 5)")

// Sign is a placeholder.
func Sign(csrPEM []byte) (certPEM, caPEM []byte, err error) {
	return nil, nil, ErrNotImplemented
}

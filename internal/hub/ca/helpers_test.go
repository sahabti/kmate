package ca

import (
	"crypto/tls"
	"math/big"
)

func tlsPair(certPEM, keyPEM []byte) (tls.Certificate, error) {
	return tls.X509KeyPair(certPEM, keyPEM)
}

func bigOne() *big.Int { return big.NewInt(1) }

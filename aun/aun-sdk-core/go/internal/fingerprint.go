package internal

import (
	"crypto/sha256"
	"crypto/x509"
	"fmt"
)

// CertFingerprint 计算证书公钥的 SHA-256 指纹
// 格式: "sha256:{hex_digest}"
func CertFingerprint(cert *x509.Certificate) string {
	der, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		return ""
	}
	hash := sha256.Sum256(der)
	return fmt.Sprintf("sha256:%x", hash)
}

// PEMFingerprint 从 DER 编码的公钥计算指纹
// 格式: "sha256:{hex_digest}"
func PEMFingerprint(publicKeyDER []byte) string {
	hash := sha256.Sum256(publicKeyDER)
	return fmt.Sprintf("sha256:%x", hash)
}

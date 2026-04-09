package aun

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

// CryptoProvider P-256 ECDSA 密钥和签名操作
type CryptoProvider struct{}

// GenerateIdentity 生成 P-256 密钥对
// 返回的 map 包含 "private_key_pem"、"public_key_der_b64"、"curve" 三个字段
func (c *CryptoProvider) GenerateIdentity() (map[string]any, error) {
	// 生成 P-256 私钥
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成 P-256 密钥对失败: %w", err)
	}

	// 私钥编码为 PEM（PKCS8 格式）
	pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("序列化私钥失败: %w", err)
	}
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: pkcs8Bytes,
	})

	// 公钥编码为 DER（SubjectPublicKeyInfo 格式）
	publicKeyDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("序列化公钥失败: %w", err)
	}

	return map[string]any{
		"private_key_pem":    string(privateKeyPEM),
		"public_key_der_b64": base64.StdEncoding.EncodeToString(publicKeyDER),
		"curve":              "P-256",
	}, nil
}

// SignLoginNonce 签名登录 nonce
// signData = "nonce:timestamp"，ECDSA SHA256 签名
// 返回 (base64 签名, 使用的时间戳, 错误)
func (c *CryptoProvider) SignLoginNonce(privateKeyPEM string, nonce string, clientTime string) (string, string, error) {
	// 解析 PEM 私钥
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return "", "", fmt.Errorf("无法解析 PEM 格式私钥")
	}

	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", "", fmt.Errorf("解析 PKCS8 私钥失败: %w", err)
	}

	ecKey, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return "", "", fmt.Errorf("私钥类型不是 ECDSA")
	}

	// 确定使用的时间戳
	usedTime := clientTime
	if usedTime == "" {
		usedTime = fmt.Sprintf("%f", float64(time.Now().UnixMilli())/1000.0)
	}

	// 构造签名数据
	signData := []byte(fmt.Sprintf("%s:%s", nonce, usedTime))
	hash := sha256.Sum256(signData)

	// ECDSA 签名
	r, s, err := ecdsa.Sign(rand.Reader, ecKey, hash[:])
	if err != nil {
		return "", "", fmt.Errorf("ECDSA 签名失败: %w", err)
	}

	// 编码为 ASN.1 DER 格式（与 Python cryptography 库兼容）
	sig, err := asn1MarshalECDSASignature(r, s)
	if err != nil {
		return "", "", fmt.Errorf("签名 ASN.1 编码失败: %w", err)
	}

	return base64.StdEncoding.EncodeToString(sig), usedTime, nil
}

// NewClientNonce 生成 12 字节随机 nonce（base64 编码）
func (c *CryptoProvider) NewClientNonce() string {
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	return base64.StdEncoding.EncodeToString(nonce)
}

// asn1MarshalECDSASignature 将 r, s 编码为 ASN.1 DER 格式
// 与 Python cryptography 库的 ECDSA 签名格式一致
func asn1MarshalECDSASignature(r, s *big.Int) ([]byte, error) {
	rBytes := r.Bytes()
	sBytes := s.Bytes()

	// 如果最高位为 1，需要补零（ASN.1 整数规则）
	if len(rBytes) > 0 && rBytes[0]&0x80 != 0 {
		rBytes = append([]byte{0x00}, rBytes...)
	}
	if len(sBytes) > 0 && sBytes[0]&0x80 != 0 {
		sBytes = append([]byte{0x00}, sBytes...)
	}

	// ASN.1 SEQUENCE { INTEGER r, INTEGER s }
	rLen := len(rBytes)
	sLen := len(sBytes)
	totalLen := 2 + rLen + 2 + sLen // 每个 INTEGER 有 tag(1) + length(1)

	result := make([]byte, 0, 2+totalLen)
	result = append(result, 0x30)           // SEQUENCE tag
	result = append(result, byte(totalLen)) // SEQUENCE length
	result = append(result, 0x02)           // INTEGER tag
	result = append(result, byte(rLen))     // INTEGER length
	result = append(result, rBytes...)
	result = append(result, 0x02)       // INTEGER tag
	result = append(result, byte(sLen)) // INTEGER length
	result = append(result, sBytes...)

	return result, nil
}

package keystore

// KeyStore 密钥存储接口
// 定义了身份密钥、证书、元数据的增删查改操作。
// 与 Python SDK keystore/base.py 的 KeyStore 抽象基类对应。
type KeyStore interface {
	// LoadKeyPair 加载指定 AID 的密钥对
	LoadKeyPair(aid string) (map[string]any, error)

	// SaveKeyPair 保存密钥对
	SaveKeyPair(aid string, keyPair map[string]any) error

	// LoadCert 加载证书（PEM 字符串）
	LoadCert(aid string) (string, error)

	// SaveCert 保存证书（PEM 字符串）
	SaveCert(aid string, certPEM string) error

	// LoadMetadata 加载元数据（tokens、prekeys 等）
	LoadMetadata(aid string) (map[string]any, error)

	// SaveMetadata 保存元数据
	SaveMetadata(aid string, metadata map[string]any) error

	// DeleteKeyPair 删除密钥对
	DeleteKeyPair(aid string) error

	// LoadIdentity 加载完整身份信息（密钥对 + 证书 + 元数据合并）
	LoadIdentity(aid string) (map[string]any, error)

	// SaveIdentity 保存完整身份信息（自动拆分到密钥对、证书、元数据）
	SaveIdentity(aid string, identity map[string]any) error

	// DeleteIdentity 删除完整身份信息
	DeleteIdentity(aid string) error
}

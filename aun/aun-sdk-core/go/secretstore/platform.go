package secretstore

// CreateDefaultSecretStore 创建平台默认的 SecretStore
// 当前所有平台统一使用 FileSecretStore。
// 未来可根据平台切换为系统级密钥链（macOS Keychain / Windows DPAPI / Linux Secret Service）。
func CreateDefaultSecretStore(root string, encryptionSeed string) (SecretStore, error) {
	return NewFileSecretStore(root, encryptionSeed)
}

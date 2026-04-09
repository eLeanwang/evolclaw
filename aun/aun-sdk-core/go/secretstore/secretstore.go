package secretstore

// SecretStore 密钥保护存储接口
// 定义了加密保护、解密还原、清除密钥的操作。
// 与 Python SDK secret_store 的抽象接口对应。
type SecretStore interface {
	// Protect 保护明文数据，返回加密记录
	// scope: 作用域（通常为 safe_aid）
	// name: 密钥名称（如 "identity/private_key"）
	// plaintext: 需要保护的明文数据
	Protect(scope, name string, plaintext []byte) (map[string]any, error)

	// Reveal 还原被保护的数据
	// scope: 作用域
	// name: 密钥名称
	// record: Protect 返回的加密记录
	Reveal(scope, name string, record map[string]any) ([]byte, error)

	// Clear 清除指定的保护记录
	Clear(scope, name string) error
}

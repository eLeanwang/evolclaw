package secretstore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"golang.org/x/crypto/pbkdf2"
)

// FileSecretStore 基于文件的 SecretStore（AES-256-GCM 加密）
//
// 密钥派生：
//   - 传入 encryptionSeed → 从 seed 字符串派生
//   - 未传 → 从 {root}/.seed 文件派生（首次自动生成）
//
// 与 Python SDK file_store.py 完全对应。
type FileSecretStore struct {
	root      string
	masterKey []byte // 32 字节 AES-256 主密钥
}

// NewFileSecretStore 创建基于文件的密钥存储
func NewFileSecretStore(root string, encryptionSeed string) (*FileSecretStore, error) {
	// 确保目录存在
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("创建密钥存储目录失败: %w", err)
	}

	var seedBytes []byte
	if encryptionSeed != "" {
		seedBytes = []byte(encryptionSeed)
	} else {
		var err error
		seedBytes, err = loadOrCreateSeed(root)
		if err != nil {
			return nil, err
		}
	}

	// PBKDF2-SHA256 派生主密钥
	masterKey := pbkdf2.Key(seedBytes, []byte("aun_file_secret_store_v1"), 100000, 32, sha256.New)

	return &FileSecretStore{
		root:      root,
		masterKey: masterKey,
	}, nil
}

// Protect 保护明文数据（AES-256-GCM 加密）
func (f *FileSecretStore) Protect(scope, name string, plaintext []byte) (map[string]any, error) {
	key := f.deriveKey(scope, name)

	// 生成 12 字节随机 nonce
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("生成随机 nonce 失败: %w", err)
	}

	// AES-256-GCM 加密
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("创建 AES 密码器失败: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("创建 GCM 模式失败: %w", err)
	}

	// GCM Seal 输出 = 密文 + 16 字节 tag
	sealed := aead.Seal(nil, nonce, plaintext, nil)
	ctLen := len(sealed) - 16
	ciphertext := sealed[:ctLen]
	tag := sealed[ctLen:]

	return map[string]any{
		"scheme":     "file_aes",
		"name":       name,
		"persisted":  true,
		"nonce":      base64.StdEncoding.EncodeToString(nonce),
		"ciphertext": base64.StdEncoding.EncodeToString(ciphertext),
		"tag":        base64.StdEncoding.EncodeToString(tag),
	}, nil
}

// Reveal 还原被保护的数据（AES-256-GCM 解密）
func (f *FileSecretStore) Reveal(scope, name string, record map[string]any) ([]byte, error) {
	// 验证 scheme 和 name
	if scheme, ok := record["scheme"].(string); !ok || scheme != "file_aes" {
		return nil, nil
	}
	recordName, _ := record["name"].(string)
	if recordName != name {
		return nil, nil
	}

	nonceB64, _ := record["nonce"].(string)
	ctB64, _ := record["ciphertext"].(string)
	tagB64, _ := record["tag"].(string)
	if nonceB64 == "" || ctB64 == "" || tagB64 == "" {
		return nil, nil
	}

	key := f.deriveKey(scope, name)

	// 解码
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return nil, nil
	}
	ciphertext, err := base64.StdEncoding.DecodeString(ctB64)
	if err != nil {
		return nil, nil
	}
	tag, err := base64.StdEncoding.DecodeString(tagB64)
	if err != nil {
		return nil, nil
	}

	// AES-256-GCM 解密
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil
	}

	// 拼接 ciphertext + tag（GCM Open 期望的格式）
	sealed := append(ciphertext, tag...)
	plaintext, err := aead.Open(nil, nonce, sealed, nil)
	if err != nil {
		return nil, nil // 解密失败返回 nil（与 Python 行为一致）
	}

	return plaintext, nil
}

// Clear 清除保护记录（FileSecretStore 无需额外清理）
func (f *FileSecretStore) Clear(scope, name string) error {
	return nil
}

// deriveKey 从主密钥派生子密钥
// 使用 HMAC-SHA256: key = HMAC(masterKey, "aun:{scope}:{name}\x01")
func (f *FileSecretStore) deriveKey(scope, name string) []byte {
	mac := hmac.New(sha256.New, f.masterKey)
	mac.Write([]byte(fmt.Sprintf("aun:%s:%s", scope, name)))
	mac.Write([]byte{0x01})
	return mac.Sum(nil)
}

// loadOrCreateSeed 从文件加载或创建随机 seed
func loadOrCreateSeed(root string) ([]byte, error) {
	seedPath := filepath.Join(root, ".seed")

	// 尝试读取已有 seed
	data, err := os.ReadFile(seedPath)
	if err == nil && len(data) > 0 {
		return data, nil
	}

	// 生成 32 字节随机 seed
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, fmt.Errorf("生成随机 seed 失败: %w", err)
	}

	// 写入文件
	if err := os.WriteFile(seedPath, seed, 0o600); err != nil {
		return nil, fmt.Errorf("写入 seed 文件失败: %w", err)
	}

	// 非 Windows 平台设置文件权限
	if runtime.GOOS != "windows" {
		_ = os.Chmod(seedPath, 0o600)
	}

	return seed, nil
}

package keystore

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/anthropics/aun-sdk-core/go/secretstore"
)

// 需要加密保护的 token 字段
var sensitiveTokenFields = []string{"access_token", "refresh_token", "kite_token"}

// 需要合并保护的关键 metadata 字段
var criticalMetadataKeys = []string{"e2ee_prekeys", "e2ee_sessions", "group_secrets"}

// secureFilePermissions 在 Unix 系统上设置文件权限为 0o600
func secureFilePermissions(path string) {
	if runtime.GOOS != "windows" {
		_ = os.Chmod(path, 0o600)
	}
}

// FileKeyStore 基于文件的密钥存储
// 目录结构: {root}/AIDs/{safe_aid}/private/key.json, public/cert.pem, tokens/meta.json
// 与 Python SDK keystore/file.py 完全对应。
type FileKeyStore struct {
	root        string
	aidsRoot    string
	secretStore secretstore.SecretStore
}

// NewFileKeyStore 创建文件密钥存储
func NewFileKeyStore(root string, ss secretstore.SecretStore, encryptionSeed string) (*FileKeyStore, error) {
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			root = ".aun"
		} else {
			root = filepath.Join(home, ".aun")
		}
	}

	// 确保目录存在
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("创建密钥存储根目录失败: %w", err)
	}

	// 如果未提供 SecretStore，创建默认的 FileSecretStore
	if ss == nil {
		var err error
		ss, err = secretstore.CreateDefaultSecretStore(root, encryptionSeed)
		if err != nil {
			return nil, fmt.Errorf("创建默认 SecretStore 失败: %w", err)
		}
	}

	aidsRoot := filepath.Join(root, "AIDs")
	if err := os.MkdirAll(aidsRoot, 0o700); err != nil {
		return nil, fmt.Errorf("创建 AIDs 目录失败: %w", err)
	}

	return &FileKeyStore{
		root:        root,
		aidsRoot:    aidsRoot,
		secretStore: ss,
	}, nil
}

// safeAID 将 AID 中的特殊字符替换为下划线
func safeAID(aid string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_")
	return r.Replace(aid)
}

// identityDir 返回指定 AID 的身份目录
func (f *FileKeyStore) identityDir(aid string) string {
	return filepath.Join(f.aidsRoot, safeAID(aid))
}

// keyPairPath 返回密钥对文件路径
func (f *FileKeyStore) keyPairPath(aid string) string {
	return filepath.Join(f.identityDir(aid), "private", "key.json")
}

// certPath 返回证书文件路径
func (f *FileKeyStore) certPath(aid string) string {
	return filepath.Join(f.identityDir(aid), "public", "cert.pem")
}

// metadataPath 返回元数据文件路径
func (f *FileKeyStore) metadataPath(aid string) string {
	return filepath.Join(f.identityDir(aid), "tokens", "meta.json")
}

// LoadKeyPair 加载密钥对
func (f *FileKeyStore) LoadKeyPair(aid string) (map[string]any, error) {
	path := f.keyPairPath(aid)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取密钥对文件失败: %w", err)
	}

	var keyPair map[string]any
	if err := json.Unmarshal(data, &keyPair); err != nil {
		return nil, fmt.Errorf("解析密钥对 JSON 失败: %w", err)
	}

	return f.restoreKeyPair(aid, keyPair), nil
}

// SaveKeyPair 保存密钥对（保护私钥）
func (f *FileKeyStore) SaveKeyPair(aid string, keyPair map[string]any) error {
	path := f.keyPairPath(aid)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建密钥对目录失败: %w", err)
	}

	// 深拷贝并保护私钥
	protected := copyMap(keyPair)
	scope := safeAID(aid)

	if privateKeyPEM, ok := protected["private_key_pem"].(string); ok && privateKeyPEM != "" {
		delete(protected, "private_key_pem")
		protection, err := f.secretStore.Protect(scope, "identity/private_key", []byte(privateKeyPEM))
		if err != nil {
			return fmt.Errorf("保护私钥失败: %w", err)
		}
		persisted, _ := protection["persisted"].(bool)
		if !persisted {
			return fmt.Errorf("SecretStore 无法持久化私钥 (scheme=%v)。私钥必须能跨进程重启保留", protection["scheme"])
		}
		protected["private_key_protection"] = protection
	} else if _, hasProtection := protected["private_key_protection"]; !hasProtection {
		_ = f.secretStore.Clear(scope, "identity/private_key")
	}

	data, err := json.MarshalIndent(protected, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化密钥对 JSON 失败: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("写入密钥对文件失败: %w", err)
	}
	secureFilePermissions(path)
	return nil
}

// LoadCert 加载证书（PEM 字符串）
func (f *FileKeyStore) LoadCert(aid string) (string, error) {
	path := f.certPath(aid)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("读取证书文件失败: %w", err)
	}
	return string(data), nil
}

// SaveCert 保存证书（PEM 字符串）
func (f *FileKeyStore) SaveCert(aid string, certPEM string) error {
	path := f.certPath(aid)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建证书目录失败: %w", err)
	}
	if err := os.WriteFile(path, []byte(certPEM), 0o644); err != nil {
		return fmt.Errorf("写入证书文件失败: %w", err)
	}
	return nil
}

// LoadMetadata 加载元数据
func (f *FileKeyStore) LoadMetadata(aid string) (map[string]any, error) {
	path := f.metadataPath(aid)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取元数据文件失败: %w", err)
	}

	var metadata map[string]any
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, fmt.Errorf("解析元数据 JSON 失败: %w", err)
	}

	return f.restoreMetadata(aid, metadata), nil
}

// SaveMetadata 保存元数据（保护敏感字段）
func (f *FileKeyStore) SaveMetadata(aid string, metadata map[string]any) error {
	path := f.metadataPath(aid)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建元数据目录失败: %w", err)
	}

	// 防御性检查：已有关键数据不被覆盖
	if existingData, err := os.ReadFile(path); err == nil {
		var existing map[string]any
		if json.Unmarshal(existingData, &existing) == nil {
			restored := f.restoreMetadata(aid, existing)
			for _, key := range criticalMetadataKeys {
				if val, ok := restored[key]; ok && val != nil {
					if _, hasNew := metadata[key]; !hasNew {
						log.Printf("save_metadata: 传入数据缺少 '%s' (aid=%s)，自动合并磁盘已有数据", key, aid)
						metadata[key] = val
					}
				}
			}
		}
	}

	protected := f.protectMetadata(aid, metadata)
	data, err := json.MarshalIndent(protected, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化元数据 JSON 失败: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("写入元数据文件失败: %w", err)
	}
	secureFilePermissions(path)
	return nil
}

// DeleteKeyPair 删除密钥对
func (f *FileKeyStore) DeleteKeyPair(aid string) error {
	path := f.keyPairPath(aid)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("删除密钥对文件失败: %w", err)
	}
	return nil
}

// LoadIdentity 加载完整身份信息
func (f *FileKeyStore) LoadIdentity(aid string) (map[string]any, error) {
	keyPair, err := f.LoadKeyPair(aid)
	if err != nil {
		return nil, err
	}
	cert, err := f.LoadCert(aid)
	if err != nil {
		return nil, err
	}
	metadata, err := f.LoadMetadata(aid)
	if err != nil {
		return nil, err
	}

	if keyPair == nil && cert == "" && metadata == nil {
		return nil, nil
	}

	identity := make(map[string]any)
	if metadata != nil {
		for k, v := range metadata {
			identity[k] = v
		}
	}
	if keyPair != nil {
		for k, v := range keyPair {
			identity[k] = v
		}
	}
	if cert != "" {
		identity["cert"] = cert
	}
	return identity, nil
}

// SaveIdentity 保存完整身份信息（自动拆分）
func (f *FileKeyStore) SaveIdentity(aid string, identity map[string]any) error {
	// 提取密钥对字段
	keyPair := make(map[string]any)
	for _, k := range []string{"private_key_pem", "public_key_der_b64", "curve"} {
		if v, ok := identity[k]; ok {
			keyPair[k] = v
		}
	}
	if len(keyPair) > 0 {
		if err := f.SaveKeyPair(aid, keyPair); err != nil {
			return err
		}
	}

	// 保存证书
	if cert, ok := identity["cert"].(string); ok && cert != "" {
		if err := f.SaveCert(aid, cert); err != nil {
			return err
		}
	}

	// 合并 metadata（先加载已有数据，再更新新字段）
	newFields := make(map[string]any)
	skipKeys := map[string]bool{"private_key_pem": true, "public_key_der_b64": true, "curve": true, "cert": true}
	for k, v := range identity {
		if !skipKeys[k] {
			newFields[k] = v
		}
	}

	existing, _ := f.LoadMetadata(aid)
	if existing == nil {
		existing = make(map[string]any)
	}
	for k, v := range newFields {
		existing[k] = v
	}

	return f.SaveMetadata(aid, existing)
}

// DeleteIdentity 删除完整身份信息
func (f *FileKeyStore) DeleteIdentity(aid string) error {
	scope := safeAID(aid)
	_ = f.secretStore.Clear(scope, "identity/private_key")
	_ = f.DeleteKeyPair(aid)

	certPath := f.certPath(aid)
	if err := os.Remove(certPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	metaPath := f.metadataPath(aid)
	if err := os.Remove(metaPath); err != nil && !os.IsNotExist(err) {
		return err
	}

	identityDir := f.identityDir(aid)
	_ = os.RemoveAll(identityDir)
	return nil
}

// LoadAnyIdentity 加载任意已存在的身份（用于首次启动场景）
func (f *FileKeyStore) LoadAnyIdentity() (map[string]any, error) {
	entries, err := os.ReadDir(f.aidsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		aid := entry.Name()
		identity, err := f.LoadIdentity(aid)
		if err != nil {
			continue
		}
		if identity != nil {
			return identity, nil
		}
	}
	return nil, nil
}

// ── 内部方法：保护与还原 ─────────────────────────────────

// restoreKeyPair 还原被保护的密钥对
func (f *FileKeyStore) restoreKeyPair(aid string, keyPair map[string]any) map[string]any {
	restored := copyMap(keyPair)
	scope := safeAID(aid)

	if record, ok := restored["private_key_protection"].(map[string]any); ok {
		value, err := f.secretStore.Reveal(scope, "identity/private_key", record)
		if err == nil && value != nil {
			restored["private_key_pem"] = string(value)
		} else {
			delete(restored, "private_key_pem")
		}
	}
	return restored
}

// protectMetadata 保护元数据中的敏感字段
func (f *FileKeyStore) protectMetadata(aid string, metadata map[string]any) map[string]any {
	protected := copyMap(metadata)
	scope := safeAID(aid)

	// 保护 token 字段
	for _, field := range sensitiveTokenFields {
		if value, ok := protected[field].(string); ok && value != "" {
			delete(protected, field)
			protection, err := f.secretStore.Protect(scope, field, []byte(value))
			if err == nil {
				protected[field+"_protection"] = protection
			}
		} else if _, hasProtection := protected[field+"_protection"]; !hasProtection {
			_ = f.secretStore.Clear(scope, field)
		}
	}

	// 保护 e2ee_sessions 中的 key
	if sessions, ok := protected["e2ee_sessions"].([]any); ok {
		sanitized := make([]any, 0, len(sessions))
		for _, raw := range sessions {
			session, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			s := copyMap(session)
			secretName := sessionSecretName(s)
			if value, ok := s["key"].(string); ok && value != "" && secretName != "" {
				delete(s, "key")
				protection, err := f.secretStore.Protect(scope, secretName, []byte(value))
				if err == nil {
					s["key_protection"] = protection
				}
			} else if secretName != "" {
				if _, hasProtection := s["key_protection"]; !hasProtection {
					_ = f.secretStore.Clear(scope, secretName)
				}
			}
			sanitized = append(sanitized, s)
		}
		protected["e2ee_sessions"] = sanitized
	}

	// 保护 e2ee_prekeys 中的 private_key_pem
	if prekeys, ok := protected["e2ee_prekeys"].(map[string]any); ok {
		sanitized := make(map[string]any)
		for prekeyID, raw := range prekeys {
			prekeyData, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			prekey := copyMap(prekeyData)
			secretName := fmt.Sprintf("e2ee_prekeys/%s/private_key", prekeyID)
			if value, ok := prekey["private_key_pem"].(string); ok && value != "" {
				delete(prekey, "private_key_pem")
				protection, err := f.secretStore.Protect(scope, secretName, []byte(value))
				if err == nil {
					prekey["private_key_protection"] = protection
				}
			} else if _, hasProtection := prekey["private_key_protection"]; !hasProtection {
				_ = f.secretStore.Clear(scope, secretName)
			}
			sanitized[prekeyID] = prekey
		}
		protected["e2ee_prekeys"] = sanitized
	}

	// 保护 group_secrets 中的 secret
	if groupSecrets, ok := protected["group_secrets"].(map[string]any); ok {
		sanitized := make(map[string]any)
		for groupID, raw := range groupSecrets {
			groupData, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			group := copyMap(groupData)
			secretName := fmt.Sprintf("group_secrets/%s/secret", groupID)
			if value, ok := group["secret"].(string); ok && value != "" {
				delete(group, "secret")
				protection, err := f.secretStore.Protect(scope, secretName, []byte(value))
				if err == nil {
					group["secret_protection"] = protection
				}
			} else if _, hasProtection := group["secret_protection"]; !hasProtection {
				_ = f.secretStore.Clear(scope, secretName)
			}

			// 保护 old_epochs 中的 secret
			if oldEpochs, ok := group["old_epochs"].([]any); ok {
				sanitizedOld := make([]any, 0, len(oldEpochs))
				for _, oldRaw := range oldEpochs {
					oldData, ok := oldRaw.(map[string]any)
					if !ok {
						continue
					}
					old := copyMap(oldData)
					oldEpoch := fmt.Sprintf("%v", old["epoch"])
					oldSecretName := fmt.Sprintf("group_secrets/%s/old/%s", groupID, oldEpoch)
					if value, ok := old["secret"].(string); ok && value != "" {
						delete(old, "secret")
						protection, err := f.secretStore.Protect(scope, oldSecretName, []byte(value))
						if err == nil {
							old["secret_protection"] = protection
						}
					} else if _, hasProtection := old["secret_protection"]; !hasProtection {
						_ = f.secretStore.Clear(scope, oldSecretName)
					}
					sanitizedOld = append(sanitizedOld, old)
				}
				group["old_epochs"] = sanitizedOld
			}

			sanitized[groupID] = group
		}
		protected["group_secrets"] = sanitized
	}

	return protected
}

// restoreMetadata 还原被保护的元数据
func (f *FileKeyStore) restoreMetadata(aid string, metadata map[string]any) map[string]any {
	restored := copyMap(metadata)
	scope := safeAID(aid)

	// 还原 token 字段
	for _, field := range sensitiveTokenFields {
		if record, ok := restored[field+"_protection"].(map[string]any); ok {
			value, err := f.secretStore.Reveal(scope, field, record)
			if err == nil && value != nil {
				restored[field] = string(value)
			} else {
				delete(restored, field)
			}
		}
	}

	// 还原 e2ee_sessions 中的 key
	if sessions, ok := restored["e2ee_sessions"].([]any); ok {
		for _, raw := range sessions {
			session, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if record, ok := session["key_protection"].(map[string]any); ok {
				secretName := sessionSecretName(session)
				if secretName != "" {
					value, err := f.secretStore.Reveal(scope, secretName, record)
					if err == nil && value != nil {
						session["key"] = string(value)
					} else {
						delete(session, "key")
					}
				}
			}
		}
	}

	// 还原 e2ee_prekeys 中的 private_key_pem
	if prekeys, ok := restored["e2ee_prekeys"].(map[string]any); ok {
		for prekeyID, raw := range prekeys {
			prekeyData, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if record, ok := prekeyData["private_key_protection"].(map[string]any); ok {
				secretName := fmt.Sprintf("e2ee_prekeys/%s/private_key", prekeyID)
				value, err := f.secretStore.Reveal(scope, secretName, record)
				if err == nil && value != nil {
					prekeyData["private_key_pem"] = string(value)
				} else {
					delete(prekeyData, "private_key_pem")
				}
			}
		}
	}

	// 还原 group_secrets 中的 secret
	if groupSecrets, ok := restored["group_secrets"].(map[string]any); ok {
		for groupID, raw := range groupSecrets {
			groupData, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if record, ok := groupData["secret_protection"].(map[string]any); ok {
				secretName := fmt.Sprintf("group_secrets/%s/secret", groupID)
				value, err := f.secretStore.Reveal(scope, secretName, record)
				if err == nil && value != nil {
					groupData["secret"] = string(value)
				} else {
					delete(groupData, "secret")
				}
			}
			// 还原 old_epochs 中的 secret
			if oldEpochs, ok := groupData["old_epochs"].([]any); ok {
				for _, oldRaw := range oldEpochs {
					oldData, ok := oldRaw.(map[string]any)
					if !ok {
						continue
					}
					if oldRecord, ok := oldData["secret_protection"].(map[string]any); ok {
						oldEpoch := fmt.Sprintf("%v", oldData["epoch"])
						oldSecretName := fmt.Sprintf("group_secrets/%s/old/%s", groupID, oldEpoch)
						value, err := f.secretStore.Reveal(scope, oldSecretName, oldRecord)
						if err == nil && value != nil {
							oldData["secret"] = string(value)
						} else {
							delete(oldData, "secret")
						}
					}
				}
			}
			_ = groupID // 避免 unused 警告
		}
	}

	return restored
}

// sessionSecretName 构建 session 密钥的 secret name
func sessionSecretName(session map[string]any) string {
	sessionID, _ := session["session_id"].(string)
	if sessionID == "" {
		return ""
	}
	return fmt.Sprintf("e2ee_sessions/%s/key", sessionID)
}

// copyMap 浅拷贝 map（一层深度）
func copyMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

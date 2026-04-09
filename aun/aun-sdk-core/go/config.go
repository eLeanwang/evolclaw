package aun

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// GetDeviceID 获取或生成本设备的稳定 ID。
// 存储在 {aunRoot}/.device_id（默认 ~/.aun/.device_id）。
// 首次调用时自动生成 UUID 并持久化，后续调用返回同一值。
// 同一台机器上所有 SDK 实例共享同一个 device_id。
func GetDeviceID(aunRoot string) string {
	if aunRoot == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			aunRoot = ".aun"
		} else {
			aunRoot = filepath.Join(home, ".aun")
		}
	}

	// 确保目录存在
	_ = os.MkdirAll(aunRoot, 0o700)

	deviceIDPath := filepath.Join(aunRoot, ".device_id")

	// 尝试读取已有 ID
	data, err := os.ReadFile(deviceIDPath)
	if err == nil {
		stored := strings.TrimSpace(string(data))
		if stored != "" {
			return stored
		}
	}

	// 生成新 UUID v4
	newID := generateUUID4()

	// 写入文件
	if err := os.WriteFile(deviceIDPath, []byte(newID), 0o600); err == nil {
		// 非 Windows 平台设置文件权限
		if runtime.GOOS != "windows" {
			_ = os.Chmod(deviceIDPath, 0o600)
		}
	}

	return newID
}

// AUNConfig SDK 配置
type AUNConfig struct {
	AUNPath                  string // AUN 数据根目录，默认 ~/.aun
	RootCAPath               string // 自定义根证书路径
	EncryptionSeed           string // 加密种子（用于 FileSecretStore 密钥派生）
	DiscoveryPort            int    // Gateway 发现端口
	GroupE2EE                bool   // 启用群组 E2EE，默认 true
	RotateOnJoin             bool   // 新成员加入时自动轮换 epoch，默认 false
	EpochAutoRotateInterval  int    // epoch 自动轮换间隔（秒），0 表示不自动轮换
	OldEpochRetentionSeconds int    // 旧 epoch 保留时间（秒），默认 604800（7 天）
	VerifySSL                bool   // 是否验证 TLS 证书，默认 true
	RequireForwardSecrecy    bool   // 是否要求前向保密，默认 true
	ReplayWindowSeconds      int    // 防重放时间窗口（秒），默认 300
}

// DefaultConfig 返回默认配置
func DefaultConfig() *AUNConfig {
	home, _ := os.UserHomeDir()
	aunPath := filepath.Join(home, ".aun")
	return &AUNConfig{
		AUNPath:                  aunPath,
		GroupE2EE:                true,
		RotateOnJoin:             false,
		EpochAutoRotateInterval:  0,
		OldEpochRetentionSeconds: 604800, // 7 天
		VerifySSL:                true,
		RequireForwardSecrecy:    true,
		ReplayWindowSeconds:      300,
	}
}

// ConfigFromMap 从字典构建配置（与 Python SDK AUNConfig.from_dict 对应）
func ConfigFromMap(raw map[string]any) *AUNConfig {
	cfg := DefaultConfig()
	if raw == nil {
		return cfg
	}

	if v, ok := raw["aun_path"].(string); ok && v != "" {
		cfg.AUNPath = v
	}
	if v, ok := raw["root_ca_path"].(string); ok {
		cfg.RootCAPath = v
	}
	if v, ok := raw["encryption_seed"].(string); ok {
		cfg.EncryptionSeed = v
	}
	if v, ok := raw["discovery_port"]; ok {
		switch dp := v.(type) {
		case float64:
			cfg.DiscoveryPort = int(dp)
		case int:
			cfg.DiscoveryPort = dp
		}
	}
	if v, ok := raw["group_e2ee"].(bool); ok {
		cfg.GroupE2EE = v
	}
	if v, ok := raw["rotate_on_join"].(bool); ok {
		cfg.RotateOnJoin = v
	}
	if v, ok := raw["epoch_auto_rotate_interval"]; ok {
		switch ei := v.(type) {
		case float64:
			cfg.EpochAutoRotateInterval = int(ei)
		case int:
			cfg.EpochAutoRotateInterval = ei
		}
	}
	if v, ok := raw["old_epoch_retention_seconds"]; ok {
		switch rs := v.(type) {
		case float64:
			cfg.OldEpochRetentionSeconds = int(rs)
		case int:
			cfg.OldEpochRetentionSeconds = rs
		}
	}
	if v, ok := raw["verify_ssl"].(bool); ok {
		cfg.VerifySSL = v
	}
	if v, ok := raw["require_forward_secrecy"].(bool); ok {
		cfg.RequireForwardSecrecy = v
	}
	if v, ok := raw["replay_window_seconds"]; ok {
		switch rw := v.(type) {
		case float64:
			cfg.ReplayWindowSeconds = int(rw)
		case int:
			cfg.ReplayWindowSeconds = rw
		}
	}
	return cfg
}

// DeviceID 返回当前设备的稳定 ID
func (c *AUNConfig) DeviceID() string {
	return GetDeviceID(c.AUNPath)
}

// generateUUID4 生成 UUID v4（不依赖外部库）
func generateUUID4() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	// 设置版本 4
	b[6] = (b[6] & 0x0f) | 0x40
	// 设置变体 RFC 4122
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

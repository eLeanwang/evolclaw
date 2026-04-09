package aun

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDefaultConfig 验证默认配置值
func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	home, _ := os.UserHomeDir()

	if cfg.AUNPath != filepath.Join(home, ".aun") {
		t.Errorf("默认 AUNPath 不正确: %s", cfg.AUNPath)
	}
	if !cfg.GroupE2EE {
		t.Error("默认 GroupE2EE 应为 true")
	}
	if cfg.RotateOnJoin {
		t.Error("默认 RotateOnJoin 应为 false")
	}
	if cfg.EpochAutoRotateInterval != 0 {
		t.Error("默认 EpochAutoRotateInterval 应为 0")
	}
	if cfg.OldEpochRetentionSeconds != 604800 {
		t.Errorf("默认 OldEpochRetentionSeconds 应为 604800, 实际: %d", cfg.OldEpochRetentionSeconds)
	}
	if !cfg.VerifySSL {
		t.Error("默认 VerifySSL 应为 true")
	}
	if !cfg.RequireForwardSecrecy {
		t.Error("默认 RequireForwardSecrecy 应为 true")
	}
	if cfg.ReplayWindowSeconds != 300 {
		t.Errorf("默认 ReplayWindowSeconds 应为 300, 实际: %d", cfg.ReplayWindowSeconds)
	}
}

// TestConfigFromMap 验证从字典构建配置
func TestConfigFromMap(t *testing.T) {
	raw := map[string]any{
		"aun_path":                  "/custom/path",
		"root_ca_path":              "/ca/root.pem",
		"encryption_seed":           "test-seed",
		"discovery_port":            20001,
		"group_e2ee":                false,
		"rotate_on_join":            true,
		"epoch_auto_rotate_interval": 3600,
		"old_epoch_retention_seconds": 86400,
		"verify_ssl":                false,
		"require_forward_secrecy":   false,
		"replay_window_seconds":     600,
	}
	cfg := ConfigFromMap(raw)

	if cfg.AUNPath != "/custom/path" {
		t.Errorf("AUNPath 不正确: %s", cfg.AUNPath)
	}
	if cfg.RootCAPath != "/ca/root.pem" {
		t.Errorf("RootCAPath 不正确: %s", cfg.RootCAPath)
	}
	if cfg.EncryptionSeed != "test-seed" {
		t.Errorf("EncryptionSeed 不正确: %s", cfg.EncryptionSeed)
	}
	if cfg.DiscoveryPort != 20001 {
		t.Errorf("DiscoveryPort 不正确: %d", cfg.DiscoveryPort)
	}
	if cfg.GroupE2EE {
		t.Error("GroupE2EE 应为 false")
	}
	if !cfg.RotateOnJoin {
		t.Error("RotateOnJoin 应为 true")
	}
	if cfg.EpochAutoRotateInterval != 3600 {
		t.Errorf("EpochAutoRotateInterval 不正确: %d", cfg.EpochAutoRotateInterval)
	}
	if cfg.OldEpochRetentionSeconds != 86400 {
		t.Errorf("OldEpochRetentionSeconds 不正确: %d", cfg.OldEpochRetentionSeconds)
	}
	if cfg.VerifySSL {
		t.Error("VerifySSL 应为 false")
	}
	if cfg.RequireForwardSecrecy {
		t.Error("RequireForwardSecrecy 应为 false")
	}
	if cfg.ReplayWindowSeconds != 600 {
		t.Errorf("ReplayWindowSeconds 不正确: %d", cfg.ReplayWindowSeconds)
	}
}

// TestConfigIgnoresUnknownKeys 验证未知键被忽略，不影响默认值
func TestConfigIgnoresUnknownKeys(t *testing.T) {
	raw := map[string]any{
		"unknown_key_1": "value",
		"unknown_key_2": 42,
		"foo_bar":       true,
	}
	cfg := ConfigFromMap(raw)
	defaults := DefaultConfig()

	if cfg.GroupE2EE != defaults.GroupE2EE {
		t.Error("未知键不应影响 GroupE2EE 默认值")
	}
	if cfg.VerifySSL != defaults.VerifySSL {
		t.Error("未知键不应影响 VerifySSL 默认值")
	}
	if cfg.ReplayWindowSeconds != defaults.ReplayWindowSeconds {
		t.Error("未知键不应影响 ReplayWindowSeconds 默认值")
	}
}

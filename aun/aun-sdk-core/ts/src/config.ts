/**
 * AUN SDK 配置管理
 *
 * 提供设备 ID 获取、配置接口定义、默认值与构建逻辑。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── 设备 ID ──────────────────────────────────────────────────

/**
 * 获取本设备的稳定 ID。
 *
 * 存储在 ~/.aun/.device_id（或 aunRoot/.device_id）。
 * 首次调用时自动生成并持久化，后续调用返回同一值。
 * 同一台机器上所有 SDK 实例共享同一个 device_id。
 */
export function getDeviceId(aunRoot?: string): string {
  const root = aunRoot ?? join(homedir(), '.aun');
  mkdirSync(root, { recursive: true });
  const deviceIdPath = join(root, '.device_id');

  if (existsSync(deviceIdPath)) {
    try {
      const stored = readFileSync(deviceIdPath, 'utf-8').trim();
      if (stored) return stored;
    } catch {
      // 平台兼容 fallback
    }
  }

  const newId = randomUUID();
  try {
    writeFileSync(deviceIdPath, newId, 'utf-8');
    if (process.platform !== 'win32') {
      try {
        chmodSync(deviceIdPath, 0o600);
      } catch {
        // 平台兼容 fallback
      }
    }
  } catch {
    // 平台兼容 fallback
  }
  return newId;
}

// ── 配置接口 ─────────────────────────────────────────────────

export interface AUNConfig {
  /** AUN 数据根目录（默认 ~/.aun） */
  aunPath: string;
  /** 根证书路径 */
  rootCaPath: string | null;
  /** 加密种子（用于 FileSecretStore 密钥派生） */
  encryptionSeed: string | null;
  /** Gateway 发现端口 */
  discoveryPort: number | null;
  /** 是否启用群组 E2EE */
  groupE2ee: boolean;
  /** 加入群组时是否轮换 epoch */
  rotateOnJoin: boolean;
  /** epoch 自动轮换间隔（秒，0 表示不自动轮换） */
  epochAutoRotateInterval: number;
  /** 旧 epoch 保留时长（秒，默认 7 天） */
  oldEpochRetentionSeconds: number;
  /** 是否验证 TLS 证书 */
  verifySsl: boolean;
  /** 是否要求前向保密 */
  requireForwardSecrecy: boolean;
  /** 防重放窗口（秒） */
  replayWindowSeconds: number;
}

// ── 默认配置 ─────────────────────────────────────────────────

/** 返回默认配置 */
export function defaultConfig(): AUNConfig {
  return {
    aunPath: join(homedir(), '.aun'),
    rootCaPath: null,
    encryptionSeed: null,
    discoveryPort: null,
    groupE2ee: true,
    rotateOnJoin: false,
    epochAutoRotateInterval: 0,
    oldEpochRetentionSeconds: 604800,
    verifySsl: true,
    requireForwardSecrecy: true,
    replayWindowSeconds: 300,
  };
}

// ── 从字典构建配置 ───────────────────────────────────────────

/** 从原始键值对构建配置（与 Python SDK 的 from_dict 对齐） */
export function configFromMap(raw: Record<string, unknown>): AUNConfig {
  const def = defaultConfig();
  const aunPath = raw.aun_path ?? raw.aunPath;
  const dp = raw.discovery_port ?? raw.discoveryPort;

  return {
    aunPath: aunPath ? String(aunPath) : def.aunPath,
    rootCaPath: raw.root_ca_path != null ? String(raw.root_ca_path) : (raw.rootCaPath != null ? String(raw.rootCaPath) : null),
    encryptionSeed: raw.encryption_seed != null ? String(raw.encryption_seed) : (raw.encryptionSeed != null ? String(raw.encryptionSeed) : null),
    discoveryPort: dp != null ? Number(dp) : null,
    groupE2ee: raw.group_e2ee != null ? Boolean(raw.group_e2ee) : (raw.groupE2ee != null ? Boolean(raw.groupE2ee) : def.groupE2ee),
    rotateOnJoin: raw.rotate_on_join != null ? Boolean(raw.rotate_on_join) : (raw.rotateOnJoin != null ? Boolean(raw.rotateOnJoin) : def.rotateOnJoin),
    epochAutoRotateInterval: raw.epoch_auto_rotate_interval != null
      ? Number(raw.epoch_auto_rotate_interval)
      : (raw.epochAutoRotateInterval != null ? Number(raw.epochAutoRotateInterval) : def.epochAutoRotateInterval),
    oldEpochRetentionSeconds: raw.old_epoch_retention_seconds != null
      ? Number(raw.old_epoch_retention_seconds)
      : (raw.oldEpochRetentionSeconds != null ? Number(raw.oldEpochRetentionSeconds) : def.oldEpochRetentionSeconds),
    verifySsl: raw.verify_ssl != null ? Boolean(raw.verify_ssl) : (raw.verifySsl != null ? Boolean(raw.verifySsl) : def.verifySsl),
    requireForwardSecrecy: raw.require_forward_secrecy != null
      ? Boolean(raw.require_forward_secrecy)
      : (raw.requireForwardSecrecy != null ? Boolean(raw.requireForwardSecrecy) : def.requireForwardSecrecy),
    replayWindowSeconds: raw.replay_window_seconds != null
      ? Number(raw.replay_window_seconds)
      : (raw.replayWindowSeconds != null ? Number(raw.replayWindowSeconds) : def.replayWindowSeconds),
  };
}

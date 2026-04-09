// ── AUN 配置 ──────────────────────────────────────────────

/**
 * 获取设备稳定 ID（浏览器环境使用 localStorage）。
 * 首次调用时自动生成 UUID 并持久化，后续返回同一值。
 */
export function getDeviceId(): string {
  const STORAGE_KEY = 'aun_device_id';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage 不可用（隐私模式等）
  }

  const newId = crypto.randomUUID();
  try {
    localStorage.setItem(STORAGE_KEY, newId);
  } catch {
    // 写入失败时仍返回生成的 ID（本次会话内有效）
  }
  return newId;
}

/** AUN SDK 配置接口 */
export interface AUNConfig {
  /** IndexedDB 数据库名前缀（默认 'aun'） */
  aunPath: string;
  /** 根证书 PEM 字符串 */
  rootCaPem: string | null;
  /** 加密种子 */
  encryptionSeed: string | null;
  /** Gateway 发现端口 */
  discoveryPort: number | null;
  /** 是否启用群组 E2EE（默认 true） */
  groupE2ee: boolean;
  /** 加入群组时是否轮换 epoch（默认 false） */
  rotateOnJoin: boolean;
  /** epoch 自动轮换间隔（秒，0 表示禁用） */
  epochAutoRotateInterval: number;
  /** 旧 epoch 保留时间（秒，默认 7 天） */
  oldEpochRetentionSeconds: number;
  /** 是否验证 SSL 证书（默认 true） */
  verifySsl: boolean;
  /** 是否要求前向保密（默认 true） */
  requireForwardSecrecy: boolean;
  /** 防重放时间窗口（秒） */
  replayWindowSeconds: number;
}

/** AUN 配置默认值 */
const DEFAULTS: AUNConfig = {
  aunPath: 'aun',
  rootCaPem: null,
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

/** 从字典创建 AUNConfig（兼容 snake_case 和 camelCase） */
export function createConfig(raw?: Partial<AUNConfig> | Record<string, any> | null): AUNConfig {
  const data = (raw ?? {}) as Record<string, any>;
  return {
    aunPath: data.aunPath ?? data.aun_path ?? DEFAULTS.aunPath,
    rootCaPem: data.rootCaPem ?? data.root_ca_pem ?? data.root_ca_path ?? DEFAULTS.rootCaPem,
    encryptionSeed: data.encryptionSeed ?? data.encryption_seed ?? DEFAULTS.encryptionSeed,
    discoveryPort: data.discoveryPort ?? data.discovery_port ?? DEFAULTS.discoveryPort,
    groupE2ee: data.groupE2ee ?? data.group_e2ee ?? DEFAULTS.groupE2ee,
    rotateOnJoin: data.rotateOnJoin ?? data.rotate_on_join ?? DEFAULTS.rotateOnJoin,
    epochAutoRotateInterval: data.epochAutoRotateInterval ?? data.epoch_auto_rotate_interval ?? DEFAULTS.epochAutoRotateInterval,
    oldEpochRetentionSeconds: data.oldEpochRetentionSeconds ?? data.old_epoch_retention_seconds ?? DEFAULTS.oldEpochRetentionSeconds,
    verifySsl: data.verifySsl ?? data.verify_ssl ?? DEFAULTS.verifySsl,
    requireForwardSecrecy: data.requireForwardSecrecy ?? data.require_forward_secrecy ?? DEFAULTS.requireForwardSecrecy,
    replayWindowSeconds: data.replayWindowSeconds ?? data.replay_window_seconds ?? DEFAULTS.replayWindowSeconds,
  };
}

export const CAPABILITY_TYPES = ['skill', 'mcp', 'plugin'] as const;

export type CapabilityType = typeof CAPABILITY_TYPES[number];
export type CapabilityMode = 'inherit' | 'all' | 'none';
export type CapabilityOverride = 'enabled' | 'disabled';
export type CapabilityItemValue = CapabilityOverride | 'inherit';
export type CapabilityEnabled = boolean | 'inherit';

export interface CapabilityTypeConfig {
  mode?: CapabilityMode;
  overrides?: Record<string, CapabilityOverride>;
}

export type CapabilityConfigByType = Partial<Record<CapabilityType, CapabilityTypeConfig>>;
export type CapabilityConfigByBaseagent = Record<string, CapabilityConfigByType | undefined>;

export type CapabilitySource =
  | 'project'
  | 'user'
  | 'plugin'
  | 'marketplace'
  | 'bundled'
  | 'system'
  | 'unknown';

export interface CapabilityOption {
  value: string;
  label: string;
  desc?: string;
  source?: CapabilitySource;
  status?: string;
  enabled: CapabilityEnabled;
  override: CapabilityOverride | null;
  runtimeEnabled?: boolean;
}

export interface CapabilityRawItem {
  id: string;
  label?: string;
  desc?: string;
  source?: CapabilitySource;
  status?: string;
  runtimeEnabled?: boolean;
  data?: unknown;
}

export interface CapabilityContext {
  aid: string;
  baseagent: string;
  projectPath: string;
}

export interface CapabilityTypeState {
  mode: CapabilityMode;
  canUpdate: boolean;
  reason?: string;
}

export interface CapabilityProvider {
  readonly baseagent: string;
  getSupport(type: CapabilityType): CapabilityTypeState;
  discover(ctx: CapabilityContext, type: CapabilityType): Promise<CapabilityRawItem[]>;
}

export function isCapabilityType(value: unknown): value is CapabilityType {
  return typeof value === 'string' && (CAPABILITY_TYPES as readonly string[]).includes(value);
}

export function normalizeCapabilityTypeConfig(value: CapabilityTypeConfig | undefined): Required<CapabilityTypeConfig> {
  const mode = value?.mode;
  const overrides = value?.overrides && typeof value.overrides === 'object'
    ? value.overrides
    : {};
  return {
    mode: mode === 'all' || mode === 'none' || mode === 'inherit' ? mode : 'inherit',
    overrides: { ...overrides },
  };
}

export function resolveCapabilityEnabled(config: CapabilityTypeConfig | undefined, id: string): CapabilityEnabled {
  const normalized = normalizeCapabilityTypeConfig(config);
  const override = normalized.overrides[id];
  if (override === 'enabled') return true;
  if (override === 'disabled') return false;
  if (normalized.mode === 'all') return true;
  if (normalized.mode === 'none') return false;
  return 'inherit';
}

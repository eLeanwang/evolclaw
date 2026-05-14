import path from 'path';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_BASEAGENTS = new Set(['claude', 'codex', 'gemini', 'hermes']);
const VALID_CHANNEL_TYPES = new Set(['feishu', 'aun', 'wechat', 'wecom', 'dingtalk', 'qqbot']);
const VALID_CHATMODES = new Set(['interactive', 'proactive']);

export function validateEvolAgentConfig(raw: any): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }

  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled must be a boolean if present');
  }

  if (!raw.agents || typeof raw.agents !== 'object') {
    errors.push('agents must be an object with exactly one baseagent block');
  } else {
    const keys = Object.keys(raw.agents).filter(k => VALID_BASEAGENTS.has(k));
    const unknownKeys = Object.keys(raw.agents).filter(k => !VALID_BASEAGENTS.has(k));
    if (unknownKeys.length > 0) {
      errors.push(`agents contains unknown baseagent keys: ${unknownKeys.join(', ')}`);
    }
    if (keys.length === 0) {
      errors.push('agents must contain exactly one of: claude | codex | gemini | hermes');
    } else if (keys.length > 1) {
      errors.push(`agents must contain exactly one baseagent (single baseagent only), got: ${keys.join(', ')}`);
    }
  }

  if (!raw.channels || typeof raw.channels !== 'object') {
    errors.push('channels is required');
  } else {
    const channelKeys = Object.keys(raw.channels);
    if (channelKeys.length === 0) {
      errors.push('channels must contain at least one channel type');
    }
    for (const key of channelKeys) {
      if (!VALID_CHANNEL_TYPES.has(key)) {
        errors.push(`unknown channel type: ${key}`);
      }
    }
  }

  if (!raw.projects || typeof raw.projects !== 'object') {
    errors.push('projects is required');
  } else {
    const p = raw.projects.defaultPath;
    if (typeof p !== 'string' || p === '') {
      errors.push('projects.defaultPath is required');
    } else if (!path.isAbsolute(p)) {
      errors.push(`projects.defaultPath must be absolute, got: ${p}`);
    }
  }

  if (raw.chatmode !== undefined) {
    if (typeof raw.chatmode !== 'object' || raw.chatmode === null) {
      errors.push('chatmode must be an object if present');
    } else {
      for (const key of ['private', 'group']) {
        const val = raw.chatmode[key];
        if (val !== undefined && !VALID_CHATMODES.has(val)) {
          errors.push(`chatmode.${key} must be 'interactive' or 'proactive'`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

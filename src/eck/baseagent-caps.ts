export interface BaseAgentCaps {
  autoLoadsRules: boolean;
  supportsSystemPrompt: boolean;
}

export const BASEAGENT_CAPS: Record<string, BaseAgentCaps> = {
  'claude-code': {
    autoLoadsRules: true,
    supportsSystemPrompt: true,
  },
  'claude': {
    autoLoadsRules: true,
    supportsSystemPrompt: true,
  },
  'codex': {
    autoLoadsRules: false,
    supportsSystemPrompt: true,
  },
  'gemini': {
    autoLoadsRules: false,
    supportsSystemPrompt: true,
  },
};

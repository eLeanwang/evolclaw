export type CanonicalBaseagent = 'claude' | 'codex' | 'gemini' | 'hermes' | 'unknown';

export interface NormalizedBaseagent {
  canonical: CanonicalBaseagent;
  displayName: string;
}

const BASEAGENT_ALIASES: Record<string, NormalizedBaseagent> = {
  claude: { canonical: 'claude', displayName: 'Claude Code' },
  cc: { canonical: 'claude', displayName: 'Claude Code' },
  'claude-code': { canonical: 'claude', displayName: 'Claude Code' },
  'claude code': { canonical: 'claude', displayName: 'Claude Code' },
  claudecode: { canonical: 'claude', displayName: 'Claude Code' },

  codex: { canonical: 'codex', displayName: 'Codex' },
  'codex-cli': { canonical: 'codex', displayName: 'Codex' },
  'codex cli': { canonical: 'codex', displayName: 'Codex' },

  gemini: { canonical: 'gemini', displayName: 'Gemini CLI' },
  'gemini-cli': { canonical: 'gemini', displayName: 'Gemini CLI' },
  'gemini cli': { canonical: 'gemini', displayName: 'Gemini CLI' },
  geminicli: { canonical: 'gemini', displayName: 'Gemini CLI' },

  hermes: { canonical: 'hermes', displayName: 'Hermes' },
};

export function normalizeBaseagent(input: string | undefined | null): NormalizedBaseagent {
  const key = String(input || '').trim().toLowerCase().replace(/_/g, '-');
  return BASEAGENT_ALIASES[key] || { canonical: 'unknown', displayName: input ? String(input) : 'Unknown' };
}

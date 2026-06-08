const SYSTEM_PROMPT_MARKERS = [
  '--- [SYSTEM_PROMPT_END] ---',
  '<system-reminder>',
  'EvolClaw Context Kit documents are shown below.',
];

const MESSAGE_ROUTE_PREFIX_RE = /^‹[^›]*·\s*from:[^›]*→\s*self:[^›]*›\s*/;

export function sanitizeSessionTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined;

  let cleanTitle = title;
  for (const marker of SYSTEM_PROMPT_MARKERS) {
    const markerIndex = cleanTitle.indexOf(marker);
    if (markerIndex >= 0) {
      cleanTitle = cleanTitle.slice(0, markerIndex);
    }
  }

  cleanTitle = cleanTitle.trim().replace(MESSAGE_ROUTE_PREFIX_RE, '').replace(/\s+/g, ' ');
  if (!cleanTitle) return undefined;
  if (/^\.+$/.test(cleanTitle)) return undefined;

  return cleanTitle.length > 80 ? `${cleanTitle.slice(0, 80)}...` : cleanTitle;
}

export function displaySessionTitle(title: unknown, fallback = '默认会话'): string {
  return sanitizeSessionTitle(title) || sanitizeSessionTitle(fallback) || fallback;
}

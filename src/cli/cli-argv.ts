export function normalizeCliArgv(argv: string[]): string[] {
  if ((argv[0] === 'ec' || argv[0] === 'evolclaw') && argv[1]) return argv.slice(1);
  return argv;
}

export type CliArgvValidation = { ok: true; argv: string[] } | { ok: false; reason: string };

export function validateCliArgv(value: unknown): CliArgvValidation {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, reason: 'args.argv must be a non-empty string array' };
  if (value.length > 64) return { ok: false, reason: 'args.argv exceeds the 64 argument limit' };
  if (value.some(arg => typeof arg !== 'string')) return { ok: false, reason: 'args.argv entries must be strings' };
  const argv = value as string[];
  if (argv.some(arg => arg.length > 4 * 1024)) return { ok: false, reason: 'args.argv entry exceeds 4096 characters' };
  if (argv.some(arg => arg.includes('\0'))) return { ok: false, reason: 'args.argv entries must not contain NUL' };
  if (argv.reduce((total, arg) => total + arg.length, 0) > 16 * 1024) {
    return { ok: false, reason: 'args.argv exceeds the 16 KiB total limit' };
  }
  return { ok: true, argv };
}

export function parseLegacyCliCommand(command: string): CliArgvValidation {
  const argv: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    if ('|&;<>()$`'.includes(char)) {
      return { ok: false, reason: 'args.command contains a forbidden shell operator' };
    }
    current += char;
  }

  if (escaped || quote) return { ok: false, reason: 'args.command contains an incomplete escape or quote' };
  if (current) argv.push(current);
  return validateCliArgv(argv);
}

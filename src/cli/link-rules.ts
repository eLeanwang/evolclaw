import fs from 'fs';
import path from 'path';
import { kitsRulesDir, resolvePaths } from '../paths.js';
import { atomicWriteJson, atomicReadJson } from '../utils/atomic-write.js';

const isWindows = process.platform === 'win32';

const KNOWN_BASEAGENTS = ['cc', 'codex', 'gemini'] as const;
type BaseAgent = (typeof KNOWN_BASEAGENTS)[number];

interface LinkEntry {
  current: string | null;
  history: string[];
}

interface LinkState {
  [baseagent: string]: LinkEntry;
}

function statePath(): string {
  return path.join(resolvePaths().eckDir, 'link-state.json');
}

function loadState(): LinkState {
  return atomicReadJson<LinkState>(statePath()) ?? {};
}

function saveState(state: LinkState): void {
  atomicWriteJson(statePath(), state);
}

function getEntry(state: LinkState, ba: string): LinkEntry {
  return state[ba] ?? { current: null, history: [] };
}

function pushHistory(entry: LinkEntry, dir: string): void {
  entry.history = [dir, ...entry.history.filter(h => h !== dir)].slice(0, 5);
}

// ── symlink 目标路径（baseagent 决定放哪）──

function resolveTarget(ba: string, dir: string): string {
  switch (ba) {
    case 'cc':
      return path.join(dir, '.claude', 'rules', 'eck');
    case 'codex':
      return path.join(dir, '.codex', 'rules', 'eck');
    case 'gemini':
      return path.join(dir, '.gemini', 'rules', 'eck');
    default:
      return path.join(dir, '.claude', 'rules', 'eck');
  }
}

// ── 创建 symlink/junction ──

function createLink(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (isWindows) {
    fs.symlinkSync(source, target, 'junction');
  } else {
    fs.symlinkSync(source, target, 'dir');
  }
}

// ── 删除 symlink/junction + 逐级清理空目录 ──

function removeLink(target: string): boolean {
  if (!fs.existsSync(target)) return false;

  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.rmSync(target, { recursive: true });
  } else if (isWindows && stat.isDirectory()) {
    const real = fs.realpathSync(target);
    const resolved = path.resolve(target);
    if (real.toLowerCase() === resolved.toLowerCase()) {
      return false; // regular directory, not a junction
    }
    fs.rmSync(target, { recursive: true });
  } else {
    return false;
  }

  cleanEmptyParents(path.dirname(target));
  return true;
}

function cleanEmptyParents(dir: string): void {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) return;
    fs.rmdirSync(dir);
    cleanEmptyParents(path.dirname(dir));
  } catch {
    // stop on error (permission, root, etc.)
  }
}

// ── 子命令 ──

function showHelp(): void {
  console.log(`Usage: evolclaw link-rules [subcommand] [baseagent] [--dir <path>]

Subcommands:
  (none)        Connect ECK rules to a project directory (default: cwd)
  status        Show connection state for all baseagents
  disconnect    Remove ECK rules connection for a baseagent

Arguments:
  baseagent     Target base agent: ${KNOWN_BASEAGENTS.join(', ')} (default: cc)
  --dir <path>  Target directory (default: current working directory)

Supported baseagents:
  cc            Claude Code (.claude/rules/eck/)
  codex         Codex (.codex/rules/eck/)
  gemini        Gemini CLI (.gemini/rules/eck/)

Examples:
  evolclaw link-rules                    # connect cc in cwd
  evolclaw link-rules codex              # connect codex in cwd
  evolclaw link-rules cc --dir /my/proj  # connect cc in specific dir
  evolclaw link-rules disconnect cc      # disconnect cc
  evolclaw link-rules status             # show all connections`);
}

function showStatus(): void {
  const state = loadState();
  const source = kitsRulesDir();

  console.log(`ECK rules source: ${source}\n`);

  for (const ba of KNOWN_BASEAGENTS) {
    const entry = getEntry(state, ba);
    const status = entry.current ? '● connected' : '○ disconnected';
    console.log(`[${ba}] ${status}`);
    if (entry.current) {
      const target = resolveTarget(ba, entry.current);
      console.log(`  path: ${entry.current}`);
      console.log(`  link: ${target}`);
    }
    if (entry.history.length > 0) {
      console.log(`  history:`);
      for (const h of entry.history) {
        console.log(`    - ${h}`);
      }
    }
    console.log('');
  }
}

function connect(ba: string, dir: string): void {
  const source = kitsRulesDir();
  if (!fs.existsSync(source)) {
    console.error(`❌ kits/rules/ not found at: ${source}`);
    process.exit(1);
  }

  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) {
    console.error(`❌ Directory does not exist: ${absDir}`);
    process.exit(1);
  }

  const state = loadState();
  const entry = getEntry(state, ba);

  // disconnect old link if exists (different dir)
  if (entry.current && entry.current !== absDir) {
    const oldTarget = resolveTarget(ba, entry.current);
    removeLink(oldTarget);
    console.log(`  disconnected old: ${entry.current}`);
  }

  // create new link
  const target = resolveTarget(ba, absDir);
  if (fs.existsSync(target)) {
    // already linked here — check if it points to our source
    try {
      const real = fs.realpathSync(target);
      const sourceReal = fs.realpathSync(source);
      if (pathEquals(real, sourceReal)) {
        console.log(`✓ Already connected: [${ba}] → ${absDir}`);
        entry.current = absDir;
        pushHistory(entry, absDir);
        state[ba] = entry;
        saveState(state);
        return;
      }
    } catch { /* fall through */ }
    console.error(`❌ Target already exists and points elsewhere: ${target}`);
    console.error(`   Run 'evolclaw link-rules disconnect ${ba}' first, or remove manually.`);
    process.exit(1);
  }

  createLink(source, target);

  entry.current = absDir;
  pushHistory(entry, absDir);
  state[ba] = entry;
  saveState(state);

  console.log(`✓ Connected: [${ba}] ${absDir}`);
  console.log(`  ${target} → ${source}`);
}

function disconnect(ba: string): void {
  const state = loadState();
  const entry = getEntry(state, ba);

  if (!entry.current) {
    console.log(`[${ba}] not connected.`);
    return;
  }

  const target = resolveTarget(ba, entry.current);
  const removed = removeLink(target);

  if (removed) {
    console.log(`✓ Disconnected: [${ba}] ${entry.current}`);
  } else if (!fs.existsSync(target)) {
    console.log(`✓ Disconnected: [${ba}] (link was already gone)`);
  } else {
    console.error(`❌ Could not remove: ${target} (not a symlink/junction)`);
  }

  entry.current = null;
  state[ba] = entry;
  saveState(state);
}

// ── 入口 ──

export function cmdLinkRules(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }

  const sub = args[0];

  if (sub === 'status') {
    showStatus();
    return;
  }

  if (sub === 'disconnect') {
    const ba = resolveBaseAgent(args[1]);
    disconnect(ba);
    return;
  }

  // default: connect
  const ba = resolveBaseAgent(sub && !sub.startsWith('-') ? sub : undefined);
  const dir = getArgValue(args, '--dir') || process.cwd();
  connect(ba, dir);
}

function resolveBaseAgent(input: string | undefined): string {
  if (!input || input === 'claude-code') return 'cc';
  if (KNOWN_BASEAGENTS.includes(input as any)) return input;
  // allow full names
  if (input === 'claude' || input === 'claude-code') return 'cc';
  console.error(`❌ Unknown baseagent: ${input}`);
  console.error(`   Supported: ${KNOWN_BASEAGENTS.join(', ')}`);
  process.exit(1);
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function pathEquals(a: string, b: string): boolean {
  if (isWindows) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
  return path.resolve(a) === path.resolve(b);
}

/**
 * CLI help 检测 helper。
 *
 * 把 7 种历史写法统一为两个语义清晰的函数：
 *   - isHelpFlag(token)：单 token 是否是 help 标记（'help' / '--help' / '-h'）
 *   - wantsHelp(args)：args 任意位置出现 help 标记
 *
 * 两套 API 服务于不同语义：
 *   - 顶层路由（如 cmdAid 看到第一个 token 是子命令名时）必须用 isHelpFlag(sub)，
 *     否则 `ec aid delete --help` 会被顶层吞掉，永远到不了 delete 自己的 help。
 *   - 单层命令（如 cmdLinkRules、cmdAid 的具体 sub 处理块内）用 wantsHelp(args)
 *     更宽松，任意位置都识别。
 */

const HELP_TOKENS = new Set(['help', '--help', '-h']);

export function isHelpFlag(token: string | undefined): boolean {
  return token !== undefined && HELP_TOKENS.has(token);
}

export function wantsHelp(args: readonly string[]): boolean {
  for (const a of args) if (HELP_TOKENS.has(a)) return true;
  return false;
}

/**
 * 取出 `--flag <value>` 形式的参数值。
 * flag 不存在或其后无值时返回 undefined。
 */
export function getArgValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}


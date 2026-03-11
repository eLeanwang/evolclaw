// 危险命令黑名单（正则表达式）
const DANGEROUS_PATTERNS = [
  /\brm\s+-\w*r\w*f/,        // rm -rf
  /\bsudo\b/,                 // sudo
  /\bmkfs\b/,                 // mkfs (格式化文件系统)
  /\bdd\s+if=/,               // dd (磁盘操作)
  /\bchmod\s+777/,            // chmod 777 (危险权限)
  />\s*\/dev\//,              // 重定向到设备文件
  /\bshutdown\b/,             // 关机
  /\breboot\b/,               // 重启
];

/**
 * 权限检查回调函数
 * 符合 Claude Agent SDK 的 can_use_tool 接口
 */
export async function canUseTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {

  // 日志：验证此函数是否在 bypassPermissions 模式下被调用
  const cmd = (input.command as string)?.substring(0, 50) || 'N/A';
  console.error(`[canUseTool] 工具=${toolName}, 命令=${cmd}`);

  // 只检查 Bash 工具，其余工具全部放行
  if (toolName === 'Bash') {
    const cmd = (input.command as string) || '';

    // 空命令直接放行
    if (!cmd || cmd.trim() === '') {
      return { behavior: 'allow', updatedInput: input };
    }

    // 检查黑名单
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        console.error(`[canUseTool] 🚫 拦截危险命令: ${cmd.substring(0, 80)}`);
        return {
          behavior: 'deny',
          message: `⛔ 危险命令被拦截: ${cmd.substring(0, 80)}`
        };
      }
    }
  }

  console.error(`[canUseTool] ✅ 允许执行`);
  // 默认允许
  return { behavior: 'allow', updatedInput: input };
}

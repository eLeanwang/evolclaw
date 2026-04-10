// 危险命令黑名单（正则表达式）
const DANGEROUS_PATTERNS = [
  // Unix
  /\brm\s+-\w*r\w*f/,        // rm -rf
  /\bsudo\b/,                 // sudo
  /\bmkfs\b/,                 // mkfs (格式化文件系统)
  /\bdd\s+if=/,               // dd (磁盘操作)
  /\bchmod\s+777/,            // chmod 777 (危险权限)
  />\s*\/dev\//,              // 重定向到设备文件
  /\bshutdown\b/,             // 关机
  /\breboot\b/,               // 重启
  // Windows
  /\bformat\s+[a-zA-Z]:/i,   // format C: (格式化磁盘)
  /\brd\s+\/s/i,              // rd /s (递归删除目录)
  /\bdel\s+\/[sfq]/i,        // del /f, /s, /q (强制删除)
  /\breg\s+delete/i,          // reg delete (删除注册表)
  /\bnet\s+stop/i,            // net stop (停止服务)
];

/**
 * 黑名单检查（用于 PreToolUse hook）
 * 检查危险命令模式，非黑名单一律放行
 */
export async function checkBlacklist(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {

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
        return {
          behavior: 'deny',
          message: `⛔ 危险命令被拦截: ${cmd.substring(0, 80)}`
        };
      }
    }
  }

  // 默认允许
  return { behavior: 'allow', updatedInput: input };
}

/**
 * 工具输入摘要（提取工具调用的可读描述，供权限审批和消息展示使用）
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';

  const extractors: Record<string, (i: any) => string | undefined> = {
    'Read':  (i) => i.file_path,
    'Edit':  (i) => i.file_path,
    'Write': (i) => i.file_path,
    'Bash':  (i) => i.command?.substring(0, 80),
    'Grep':  (i) => `pattern: ${i.pattern}`,
    'Glob':  (i) => `pattern: ${i.pattern}`,
    'Agent': (i) => i.description || i.prompt?.substring(0, 80),
    'Skill': (i) => i.skill ? `${i.skill}${i.args ? ' ' + i.args : ''}` : undefined,
    'TodoWrite': (i) => {
      if (Array.isArray(i.todos)) {
        return i.todos.map((t: any) => t.content || t.task || t.text).filter(Boolean).join(', ').substring(0, 80);
      }
      return undefined;
    },
    'TaskCreate': (i) => i.subject || i.description?.substring(0, 80),
    'TaskUpdate': (i) => i.status ? `${i.taskId} → ${i.status}` : i.taskId,
    'NotebookEdit': (i) => i.notebook_path,
    'WebFetch': (i) => i.url,
    'WebSearch': (i) => i.query?.substring(0, 80),
  };

  const extractor = extractors[toolName];
  if (extractor) {
    const result = extractor(input);
    if (result) return result;
  }

  return (input as any).description
    || (input as any).subject
    || (input as any).file_path
    || (input as any).pattern
    || (input as any).command?.substring(0, 80)
    || (input as any).prompt?.substring(0, 80)
    || (input as any).query?.substring(0, 80)
    || (input as any).skill
    || (input as any).url
    || '';
}

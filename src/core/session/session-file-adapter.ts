/**
 * SessionFileAdapter — 会话文件操作的 Agent 抽象层
 *
 * 不同 Agent 后端（Claude / Codex）使用不同的会话文件存储格式和路径。
 * 此接口将文件操作抽象为统一 API，由各 Agent 适配器分别实现。
 */

export interface SessionFileInfo {
  turns: number;
  title?: string;
}

export interface CliSessionEntry {
  uuid: string;
  mtime: number;
}

export interface SdkSessionEntry {
  sessionId: string;
  title?: string;
}

export interface SessionFileAdapter {
  readonly baseagent: string;

  /** 检查会话文件是否存在 */
  checkExists(projectPath: string, agentSessionId: string): boolean;

  /** 获取会话信息（轮数 + 标题） */
  getFileInfo(projectPath: string, agentSessionId: string): SessionFileInfo;

  /** 读取首条用户消息（CLI 会话预览） */
  readFirstMessage(projectPath: string, agentSessionId: string): string | null;

  /** 读取最后一条用户消息（切换会话时显示上下文） */
  readLastUserMessage(projectPath: string, agentSessionId: string): string | null;

  /** 扫描孤立 CLI 会话（未被 DB 绑定的） */
  scanCliSessions(projectPath: string): CliSessionEntry[];

  /** 列出 SDK 侧的会话列表（用于名称同步），可选实现 */
  listSdkSessions?(projectPath: string): Promise<SdkSessionEntry[]>;

  /** 清理资源（关闭 DB 连接等） */
  close?(): void;
}

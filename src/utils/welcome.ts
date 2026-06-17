/**
 * 统一的欢迎消息模块
 *
 * 包含欢迎消息生成、管理器和渠道帮助函数
 *
 * 设计：
 * - AUN：connect 时发送给预配置的 owner（协议内建机制，P2P 主动推送）
 * - 所有 IM 渠道（Feishu/WeChat/DingTalk/QQBot/WeCom）：首次交互时发送给交互用户（被动响应）
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { loadAgent, saveAgent } from '../config-store.js';
import { logger } from './logger.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface WelcomeMessageOptions {
  /** 渠道类型（用于渠道特定说明） */
  channelType: 'aun' | 'feishu' | 'wechat' | 'dingtalk' | 'qqbot' | 'wecom';
  /** Agent 显示名称（可选） */
  agentName?: string;
  /** Owner 显示名称（可选） */
  ownerName?: string;
  /** 是否包含绑定凭证说明（仅 AUN） */
  includeBindingNote?: boolean;
}

// ============================================================================
// 欢迎消息生成
// ============================================================================

/**
 * 生成统一的欢迎消息文本
 */
export function generateWelcomeMessage(options: WelcomeMessageOptions): string {
  const channelDesc = getChannelDescription(options.channelType);
  const greeting = options.ownerName
    ? `👋 你好，${options.ownerName}！`
    : '👋 你好！';

  const agentIntro = options.agentName
    ? `我是 ${options.agentName}，你的 AI Agent 网关。`
    : '我是您的 AI Agent 网关。';

  const channelInfo = `已成功连接到${channelDesc}。`;

  const channelSpecificNote = getChannelSpecificNote(options.channelType);

  const bindingNote = options.includeBindingNote
    ? `\n\n🔐 **绑定说明**：\n- 这条消息表示您的设备已和此 Agent 绑定\n- 只有您能看到和使用这个 Agent\n- AUN 提供端到端加密和跨设备同步`
    : '';

  return `🎉 欢迎使用 EvolClaw！

${greeting}

${agentIntro}${channelInfo}

📋 **日常使用方法**：

1. **查看帮助**：发送 \`/help\` 查看所有可用命令
2. **查看状态**：发送 \`/status\` 查看当前会话状态
3. **会话管理**：发送 \`/session\` 查看和切换会话

💡 **提示**：
- 直接发送消息即可与 Claude/Codex 对话
- 支持多会话管理，每个会话独立上下文
- 所有命令以 \`/\` 开头${channelSpecificNote}${bindingNote}

现在就可以开始工作了！`;
}

/**
 * 生成简化版欢迎消息（用于快速场景）
 */
export function generateQuickWelcome(channelType: string, agentName?: string): string {
  const channelDesc = getChannelDescription(channelType as any);
  const intro = agentName ? `${agentName} 已连接` : '已连接';
  return `👋 ${intro}到${channelDesc}！\n发送 /help 查看可用命令。`;
}

/**
 * 生成 init 完成后的控制台提示消息
 */
export function generateInitSuccessMessage(
  channelType: string,
  hasOwner: boolean
): string {
  const channelName = getChannelDescription(channelType as any);

  // AUN 在 connect 时向 owner 发送欢迎消息
  if (hasOwner && channelType === 'aun') {
    return `\n💡 提示：首次启动时会向 owner 发送欢迎消息
   启动服务: evolclaw start`;
  }

  // Feishu 虽然有 owner，但已改为首次交互发送（与其他 IM 统一）
  if (hasOwner && channelType === 'feishu') {
    return `\n💡 提示：首次用户交互时会发送欢迎消息
   启动服务: evolclaw start`;
  }

  // 其他 IM 渠道：首次交互发送
  if (hasOwner) {
    return `\n💡 提示：${channelName}渠道已配置
   启动服务: evolclaw start`;
  }

  // 无 owner 的渠道
  return `\n💡 提示：${channelName}渠道已配置
   启动服务: evolclaw start
   配置 owner: evolclaw init ${channelType}`;
}

/**
 * 获取渠道的中文描述
 */
function getChannelDescription(channelType: 'aun' | 'feishu' | 'wechat' | 'dingtalk' | 'qqbot' | 'wecom'): string {
  switch (channelType) {
    case 'aun':
      return 'AUN 网络';
    case 'feishu':
      return '飞书';
    case 'wechat':
      return '微信';
    case 'dingtalk':
      return '钉钉';
    case 'qqbot':
      return 'QQ';
    case 'wecom':
      return '企业微信';
    default:
      return '未知渠道';
  }
}

/**
 * 获取渠道特定的额外说明
 */
function getChannelSpecificNote(channelType: string): string {
  switch (channelType) {
    case 'aun':
      return '\n- AUN 提供端到端加密和跨设备同步';
    case 'feishu':
      return '\n- 群聊中使用 @机器人 来触发对话';
    case 'wechat':
      return '';
    case 'dingtalk':
      return '\n- 群聊中使用 @机器人 来触发对话';
    case 'qqbot':
      return '\n- 群聊中使用 @机器人 来触发对话';
    case 'wecom':
      return '';
    default:
      return '';
  }
}

// ============================================================================
// 欢迎消息管理器
// ============================================================================

/**
 * 标记 agent 已初始化
 */
export function markAgentInitialized(agentAid: string): void {
  const agentConfig = loadAgent(agentAid);
  if (agentConfig) {
    agentConfig.initialized = true;
    saveAgent(agentConfig);
    logger.info(`[WelcomeManager] Marked ${agentAid} as initialized`);
  }
}

/**
 * 首次交互欢迎消息管理器（用于所有 IM 渠道：Feishu/WeChat/DingTalk/QQBot/WeCom）
 */
export class FirstInteractionWelcomeManager {
  private greetedUsersFile: string;
  private greetedUsers = new Set<string>();
  private initializedCache: boolean | null = null; // 缓存 initialized 状态，避免重复 I/O

  constructor(
    private channelType: string,
    private agentAid: string,
    private channelName: string
  ) {
    // 每个 channel instance 独立的已欢迎用户记录
    this.greetedUsersFile = path.join(
      resolvePaths().dataDir,
      `${channelType}-greeted-${channelName}.jsonl`
    );
    this.loadGreetedUsers();
  }

  /**
   * 检查是否应该向该用户发送欢迎消息
   */
  shouldGreet(userId: string): boolean {
    // 懒加载并缓存 initialized 状态（避免每条消息都读取磁盘）
    if (this.initializedCache === null) {
      const agentConfig = loadAgent(this.agentAid);
      this.initializedCache = agentConfig?.initialized === true;
    }

    // Agent 已初始化 → 所有用户都不需要欢迎消息
    if (this.initializedCache) {
      return false;
    }

    // 该用户未被欢迎过
    return !this.greetedUsers.has(userId);
  }

  /**
   * 生成欢迎消息文本
   */
  generateWelcomeText(): string {
    const agentName = this.agentAid.split('.')[0];
    return generateWelcomeMessage({
      channelType: this.channelType as any,
      agentName,
    });
  }

  /**
   * 标记用户已被欢迎
   */
  markGreeted(userId: string): void {
    if (this.greetedUsers.has(userId)) return;

    this.greetedUsers.add(userId);
    this.persistGreetedUser(userId);

    // 首个用户被欢迎后，标记 agent 已初始化
    if (this.greetedUsers.size === 1) {
      markAgentInitialized(this.agentAid);
    }
  }

  /**
   * 持久化已欢迎用户到文件
   */
  private persistGreetedUser(userId: string): void {
    try {
      const record = { userId, timestamp: Date.now() };
      fs.appendFileSync(this.greetedUsersFile, JSON.stringify(record) + '\n', 'utf-8');
    } catch (e) {
      logger.warn(`[WelcomeManager] Failed to persist greeted user: ${e}`);
    }
  }

  /**
   * 从文件加载已欢迎用户列表
   */
  private loadGreetedUsers(): void {
    if (!fs.existsSync(this.greetedUsersFile)) return;

    try {
      const content = fs.readFileSync(this.greetedUsersFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const { userId } = JSON.parse(line);
          if (userId) this.greetedUsers.add(userId);
        } catch {
          // 忽略损坏的行
        }
      }

      if (this.greetedUsers.size > 0) {
        logger.debug(`[WelcomeManager] Loaded ${this.greetedUsers.size} greeted users for ${this.channelName}`);
      }
    } catch (e) {
      logger.warn(`[WelcomeManager] Failed to load greeted users: ${e}`);
    }
  }
}

// ============================================================================
// 渠道帮助函数
// ============================================================================

/**
 * 初始化欢迎消息管理器（同步方式，避免竞态条件）
 */
export function initWelcomeManager(
  channelType: 'feishu' | 'wechat' | 'dingtalk' | 'qqbot' | 'wecom',
  agentAid: string,
  channelName: string
): FirstInteractionWelcomeManager {
  return new FirstInteractionWelcomeManager(channelType, agentAid, channelName);
}

/**
 * 发送欢迎消息（如果需要）
 *
 * @param welcomeManager 欢迎消息管理器实例
 * @param userId 用户 ID
 * @param channelId 渠道 ID（消息发送目标）
 * @param sendMessage 发送消息的函数
 * @param channelName 渠道名称（用于日志）
 * @returns 是否发送了欢迎消息
 */
export async function sendWelcomeIfNeeded(
  welcomeManager: FirstInteractionWelcomeManager | undefined,
  userId: string,
  channelId: string,
  sendMessage: (channelId: string, text: string) => Promise<void>,
  channelName: string
): Promise<boolean> {
  if (!welcomeManager?.shouldGreet(userId)) {
    return false;
  }

  const welcomeText = welcomeManager.generateWelcomeText();
  try {
    await sendMessage(channelId, welcomeText);
    welcomeManager.markGreeted(userId);
    logger.info(`[${channelName}] Welcome message sent to user: ${userId}`);
    return true;
  } catch (err) {
    logger.warn(`[${channelName}] Failed to send welcome message:`, err);
    return false;
  }
}

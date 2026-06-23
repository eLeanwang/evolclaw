/**
 * 消息处理器接口
 *
 * 定义消息处理引擎的标准契约。
 * ResponseEngine 实现此接口；MessageProcessor（已归档）曾实现此接口。
 */

import type { AgentRunnerFull } from '../../agents/runner-types.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ChannelAdapter, ChannelPolicy, ChannelOptions, Message, EvolAgentRegistryHandle } from '../../types.js';
import type { InteractionRouter } from '../interaction-router.js';
import type { MessageQueue } from './message-queue.js';

/**
 * 消息处理器接口
 *
 * 负责：
 * - 接收来自不同渠道的消息
 * - 协调 Agent Runner 处理消息
 * - 管理会话状态和消息队列
 * - 处理渠道注册和适配器管理
 */
export interface IMessageProcessor {
  /**
   * 获取 Agent Runner 实例
   * @param channel 渠道名称（可选）
   * @param baseagent baseagent 标识（可选）
   */
  getAgent(channel?: string, baseagent?: string): AgentRunnerFull;

  /**
   * 获取所有可用的 Agent 标识列表
   */
  getAvailableAgents(): string[];

  /**
   * 设置交互路由器（处理按钮/菜单等交互）
   */
  setInteractionRouter(router: InteractionRouter): void;

  /**
   * 设置消息队列（管理待处理消息）
   */
  setMessageQueue(queue: MessageQueue): void;

  /**
   * 设置 Agent 注册表（解析 agent 配置）
   */
  setAgentRegistry(registry: EvolAgentRegistryHandle): void;

  /**
   * 注册渠道适配器
   * @param adapter 渠道适配器
   * @param policy 渠道策略（权限/限流等）
   * @param options 渠道选项
   */
  registerChannel(adapter: ChannelAdapter, policy: ChannelPolicy, options?: ChannelOptions): void;

  /**
   * 注销渠道适配器
   * @param channelName 渠道名称
   */
  unregisterChannel(channelName: string): void;

  /**
   * 获取渠道适配器
   * @param channelName 渠道名称
   */
  getAdapter(channelName: string): ChannelAdapter | undefined;

  /**
   * 获取渠道完整信息（适配器 + 策略 + 选项）
   * @param channelName 渠道名称
   */
  getChannelInfo(channelName: string): { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy } | undefined;

  /**
   * 处理会话压缩开始事件（用于抑制输出）
   * @param sessionId 会话 ID（可选，未提供则抑制所有会话）
   */
  handleCompactStart(sessionId?: string): void;

  /**
   * 处理消息（核心入口）
   * @param message 入站消息
   */
  processMessage(message: Message): Promise<void>;
}

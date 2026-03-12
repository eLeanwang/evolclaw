import { InstanceManager } from './gateway/instance-manager.js';
import { FailureHandler } from './gateway/failure-handler.js';
import { FeishuChannel } from '../channels/feishu.js';
import { ACPChannel } from '../channels/acp.js';
import { SessionManager } from '../core/session-manager.js';
import { loadConfig, ensureDir } from '../config.js';
import { logger } from '../utils/logger.js';
import Database from 'better-sqlite3';

async function main() {
  const config = loadConfig();

  // 初始化数据库（用于消息去重）
  ensureDir('./data');
  const db = new Database('./data/gateway.db');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_messages(processed_at);
  `);

  // 初始化 Gateway 组件
  const instanceManager = new InstanceManager({
    maxInstances: 20,
    idleTimeout: 30 * 60 * 1000,
    apiKey: config.claude?.apiKey
  });

  const failureHandler = new FailureHandler(instanceManager, {
    retry: {
      maxAttempts: 3,
      backoff: 'exponential',
      initialDelay: 1000
    },
    restart: {
      enabled: true,
      maxRestarts: 5,
      cooldown: 60000
    }
  });

  const sessionManager = new SessionManager();

  // 消息处理函数
  async function handleMessage(channel: 'feishu' | 'acp', channelId: string, content: string) {
    const message = { channel, channelId, content, timestamp: Date.now() };
    // TODO: 旧版 API 已废弃，需要适配新的 SessionManager API
    const claudeSessionId = `${channel}-${channelId}`;

    const instance = await instanceManager.getOrCreateInstance(claudeSessionId, config.projects?.defaultPath || process.cwd());
    const response = await instance.query(content);

    return response;
  }

  // 飞书渠道
  const feishu = new FeishuChannel({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    db
  });
  feishu.onMessage(async (chatId, content) => {
    try {
      const response = await handleMessage('feishu', chatId, content);
      await feishu.sendMessage(chatId, response);
    } catch (error) {
      logger.error('Feishu message error:', error);
    }
  });

  // ACP 渠道
  const acp = new ACPChannel({ domain: config.acp.domain, agentName: config.acp.agentName });
  acp.onMessage(async (sessionId, content) => {
    try {
      const response = await handleMessage('acp', sessionId, content);
      await acp.sendMessage(sessionId, response);
    } catch (error) {
      logger.error('ACP message error:', error);
    }
  });

  await feishu.connect();
  await acp.connect();

  logger.info('EvolClaw Gateway started');
  logger.info(`- Max instances: ${instanceManager.getMetrics().total}`);

  // 优雅关闭
  process.on('SIGINT', async () => {
    logger.info('\nShutting down...');
    await feishu.disconnect();
    await acp.disconnect();
    await instanceManager.shutdown();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});

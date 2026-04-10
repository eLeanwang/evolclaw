import fs from 'fs';
import readline from 'readline';
import { resolvePaths } from '../paths.js';
import { normalizeChannelInstances } from '../config.js';
import { selectInstance, InstanceChoice } from './init-common.js';

const FEISHU_PROD_URL = 'https://accounts.feishu.cn';
const LARK_PROD_URL = 'https://accounts.larksuite.com';
const POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 600_000;

const SKIP = Symbol('SKIP');
const QUIT = Symbol('QUIT');

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

interface QRBeginResponse {
  verification_uri_complete?: string;
  device_code?: string;
  interval?: number;
  expires_in?: number;
  expire_in?: number;
}

interface QRPollResponse {
  client_id?: string;
  client_secret?: string;
  user_info?: {
    tenant_brand?: string;
    open_id?: string;
  };
  error?: string;
  error_description?: string;
}

interface RegistrationResult {
  appId: string;
  appSecret: string;
  domain: string;
  openId: string;
}

class FeishuQrRegistrationClient {
  private baseUrl: string;

  constructor(isLark = false) {
    this.baseUrl = isLark ? LARK_PROD_URL : FEISHU_PROD_URL;
  }

  setDomain(isLark: boolean): void {
    this.baseUrl = isLark ? LARK_PROD_URL : FEISHU_PROD_URL;
  }

  async init(): Promise<{ supported_auth_methods?: string[] }> {
    return this.postRegistration('init', {});
  }

  async begin(): Promise<QRBeginResponse> {
    return this.postRegistration('begin', {
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
  }

  async poll(deviceCode: string): Promise<QRPollResponse> {
    return this.postRegistration('poll', { device_code: deviceCode });
  }

  private async postRegistration(action: string, extraParams: Record<string, string>): Promise<any> {
    const body = new URLSearchParams({ action, ...extraParams }).toString();
    const res = await fetch(`${this.baseUrl}/oauth/v1/app/registration`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  }
}

async function runQrRegistrationFlow(): Promise<RegistrationResult | typeof SKIP | typeof QUIT> {
  const client = new FeishuQrRegistrationClient();

  const initResult = await client.init();
  const authMethods = Array.isArray(initResult.supported_auth_methods) ? initResult.supported_auth_methods : [];
  if (!authMethods.includes('client_secret')) {
    throw new Error('当前环境不支持 client_secret 注册');
  }

  const beginResult = await client.begin();
  if (!beginResult.verification_uri_complete || !beginResult.device_code) {
    throw new Error('服务端未返回扫码链接或 device_code');
  }

  // 显示二维码
  try {
    const qrterm = await import('qrcode-terminal');
    await new Promise<void>(resolve => {
      qrterm.default.generate(beginResult.verification_uri_complete!, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log(`请在浏览器中打开此链接扫码: ${beginResult.verification_uri_complete}\n`);
  }

  console.log('请用飞书/Lark 扫描上方二维码...\n');
  console.log('按 q 退出 | 按 s 跳过扫码手动输入 appId/appSecret\n');

  let userAction: typeof SKIP | typeof QUIT | null = null;
  const setupKeyListener = () => {
    if (!process.stdin.isTTY) return () => {};
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const handler = (key: string) => {
      if (key === 'q' || key === '\u0003') userAction = QUIT;
      if (key === 's') userAction = SKIP;
    };
    process.stdin.on('data', handler);
    return () => {
      process.stdin.removeListener('data', handler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  };

  const cleanup = setupKeyListener();

  const startedAt = Date.now();
  let pollIntervalSeconds = Number(beginResult.interval ?? 5);
  const expireInSeconds = Number(beginResult.expires_in ?? beginResult.expire_in ?? 600);
  let domainResolved = false;
  let currentDomain = 'feishu';

  try {
    while (Date.now() - startedAt < expireInSeconds * 1000) {
      if (userAction === QUIT) return QUIT;
      if (userAction === SKIP) return SKIP;

      const pollResult = await client.poll(beginResult.device_code);

      if (pollResult.user_info?.tenant_brand === 'lark' && !domainResolved) {
        client.setDomain(true);
        currentDomain = 'lark';
        domainResolved = true;
      }

      if (pollResult.client_id && pollResult.client_secret) {
        return {
          appId: pollResult.client_id,
          appSecret: pollResult.client_secret,
          domain: currentDomain,
          openId: pollResult.user_info?.open_id ?? '',
        };
      }

      if (pollResult.error === 'authorization_pending') {
        await new Promise(r => setTimeout(r, pollIntervalSeconds * 1000));
        continue;
      }

      if (pollResult.error === 'slow_down') {
        pollIntervalSeconds += 5;
        await new Promise(r => setTimeout(r, pollIntervalSeconds * 1000));
        continue;
      }

      if (pollResult.error === 'access_denied') {
        throw new Error('用户拒绝了扫码授权');
      }

      if (pollResult.error === 'expired_token') {
        throw new Error('扫码会话已过期');
      }

      if (pollResult.error) {
        throw new Error(`扫码注册失败: ${pollResult.error}${pollResult.error_description ? ` - ${pollResult.error_description}` : ''}`);
      }

      await new Promise(r => setTimeout(r, pollIntervalSeconds * 1000));
    }

    throw new Error('等待扫码结果超时');
  } finally {
    cleanup();
  }
}

async function manualInput(rl: readline.Interface): Promise<RegistrationResult> {
  console.log('\n手动输入模式:\n');
  let appId = '';
  while (!appId) {
    appId = (await ask(rl, '  飞书 App ID: ')).trim();
    if (!appId) console.log('  ⚠ 不能为空');
  }

  let appSecret = '';
  while (!appSecret) {
    appSecret = (await ask(rl, '  飞书 App Secret: ')).trim();
    if (!appSecret) console.log('  ⚠ 不能为空');
  }

  return { appId, appSecret, domain: 'unknown', openId: '' };
}

export async function runFeishuQrFlow(): Promise<{ appId: string; appSecret: string; openId: string } | null> {
  try {
    const result = await runQrRegistrationFlow();
    if (result === QUIT || result === SKIP) return null;
    return result;
  } catch (error) {
    console.error(`\n登录失败: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export async function cmdInitFeishu(): Promise<void> {
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log(`❌ 配置文件不存在，请先运行 evolclaw init`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  // Normalize existing instances and filter out placeholders
  const allInstances = normalizeChannelInstances(config.channels?.feishu, 'feishu');
  const validInstances: Array<{ name: string; originalIndex: number; [key: string]: any }> = [];
  for (let i = 0; i < allInstances.length; i++) {
    const inst = allInstances[i];
    if (!inst.appId || !inst.appSecret) continue;
    if (inst.appId.includes('your-') || inst.appId.includes('placeholder')) continue;
    if (inst.appSecret.includes('your-') || inst.appSecret.includes('placeholder')) continue;
    validInstances.push({ ...inst, originalIndex: i });
  }

  let choice: InstanceChoice | null = null;

  if (validInstances.length > 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      choice = await selectInstance(rl, 'feishu', validInstances);
      if (choice === null) return; // user cancelled
    } finally {
      rl.close();
    }
  }

  console.log('正在获取飞书登录二维码...\n');

  let result: RegistrationResult;
  try {
    const flowResult = await runQrRegistrationFlow();

    if (flowResult === QUIT) {
      console.log('已退出');
      return;
    }

    if (flowResult === SKIP) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        result = await manualInput(rl);
      } finally {
        rl.close();
      }
    } else {
      result = flowResult;
    }
  } catch (error) {
    console.error(`\n登录失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Write config to the correct slot
  if (!config.channels) config.channels = {};

  if (choice && choice.action === 'overwrite' && Array.isArray(config.channels.feishu)) {
    // Overwrite existing instance in array — use originalIndex to find the right slot
    const idx = validInstances[choice.index]?.originalIndex ?? choice.index;
    config.channels.feishu[idx].appId = result.appId;
    config.channels.feishu[idx].appSecret = result.appSecret;
    config.channels.feishu[idx].enabled = true;
    if (result.openId) config.channels.feishu[idx].owner = result.openId;
  } else if (choice && choice.action === 'overwrite' && !Array.isArray(config.channels.feishu)) {
    // Overwrite single-object
    config.channels.feishu = config.channels.feishu || {};
    config.channels.feishu.appId = result.appId;
    config.channels.feishu.appSecret = result.appSecret;
    config.channels.feishu.enabled = true;
    if (result.openId) config.channels.feishu.owner = result.openId;
    else delete config.channels.feishu.owner;
  } else if (choice && choice.action === 'add') {
    // Add new instance — upgrade to array if needed
    const newInst = {
      name: choice.name,
      appId: result.appId,
      appSecret: result.appSecret,
      enabled: true,
      ...(result.openId ? { owner: result.openId } : {}),
    };
    if (Array.isArray(config.channels.feishu)) {
      config.channels.feishu.push(newInst);
    } else if (config.channels.feishu) {
      // Upgrade single object to array
      const oldInst = { ...config.channels.feishu, name: config.channels.feishu.name || 'feishu' };
      config.channels.feishu = [oldInst, newInst];
    } else {
      config.channels.feishu = [newInst];
    }
  } else {
    // First instance — single object format (backward compat)
    config.channels.feishu = config.channels.feishu || {};
    config.channels.feishu.appId = result.appId;
    config.channels.feishu.appSecret = result.appSecret;
    config.channels.feishu.enabled = true;
    if (result.openId) config.channels.feishu.owner = result.openId;
    else delete config.channels.feishu.owner;
  }

  if (!config.channels.defaultChannel) config.channels.defaultChannel = 'feishu';

  fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');

  console.log(`\n✅ 飞书连接成功！`);
  console.log(`  App ID: ${result.appId}`);
  if (result.openId) {
    console.log(`  Owner: ${result.openId}`);
  }
  if (result.domain !== 'unknown') {
    console.log(`  Domain: ${result.domain}`);
  }
  if (choice) {
    console.log(`  实例: ${choice.name} (${choice.action === 'add' ? '新增' : '覆盖'})`);
  }
  console.log(`  配置已写入: ${p.config}`);
  console.log(`\n现在可以启动服务: evolclaw restart`);
}


/**
 * Channel-specific init flows: Feishu, WeChat, AUN
 *
 * Each channel provides:
 *   - cmdInit<Channel>()  — standalone `evolclaw init <channel>` entry
 *   - run<Channel>QrFlow() or setupAun*() — reusable primitives for the main init wizard
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { resolvePaths } from '../paths.js';
import { normalizeChannelInstances } from './channel-helpers.js';
import { selectInstance, type InstanceChoice } from './init.js';
import { npmInstallGlobal, requireOptional } from './npm-ops.js';
import { loadAllAgents, loadAgent } from '../config-store.js';
import { agentChannelUpsert } from '../agent/index.js';
import type { ChannelInstance, AgentConfig } from '../types.js';
import {
  AUN_CORE_SDK_PKG,
  MIN_AUN_CORE_SDK,
  resolveAunCoreSdkPkg,
  isAunSdkVersionOk,
  isValidAid,
  aidCreate,
  agentmdPut,
  buildInitialAgentMd,
} from '../aun/aid/index.js';

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

// ==================== Feishu ====================

const FEISHU_PROD_URL = 'https://accounts.feishu.cn';
const LARK_PROD_URL = 'https://accounts.larksuite.com';

const SKIP = Symbol('SKIP');
const QUIT = Symbol('QUIT');

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
  console.log('\n手动输入模式：\n');
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let aid: string | null = null;
  let agentConfig: AgentConfig | null = null;
  let choice: InstanceChoice | null = null;

  try {
    aid = await pickAgentForChannel(rl);
    if (!aid) return;

    agentConfig = loadAgent(aid);
    if (!agentConfig) {
      console.error(`❌ 无法加载 agent ${aid} 的配置`);
      return;
    }
    const existing = (agentConfig.channels || []).filter(c => c.type === 'feishu');
    choice = await pickInstanceWithinAgent(rl, 'feishu', existing);
    if (choice === null) return;
  } finally {
    rl.close();
  }

  console.log('\n正在获取飞书登录二维码...\n');

  let result: RegistrationResult;
  try {
    const flowResult = await runQrRegistrationFlow();
    if (flowResult === QUIT) {
      console.log('已退出');
      return;
    }
    if (flowResult === SKIP) {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { result = await manualInput(rl2); } finally { rl2.close(); }
    } else {
      result = flowResult;
    }
  } catch (error) {
    console.error(`\n登录失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const channel: ChannelInstance = {
    type: 'feishu',
    name: choice.name,
    enabled: true,
    appId: result.appId,
    appSecret: result.appSecret,
    ...(result.openId ? { owners: [result.openId] } : {}),
  } as ChannelInstance;

  await commitChannel(aid!, channel, choice.action);

  console.log(`  App ID: ${result.appId}`);
  if (result.openId) console.log(`  Owner: ${result.openId}`);
  if (result.domain !== 'unknown') console.log(`  Domain: ${result.domain}`);
}

// ==================== WeChat ====================

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const QR_POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 480_000;

interface WechatQRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface WechatQRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

async function fetchQRCode(baseUrl: string): Promise<WechatQRCodeResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as WechatQRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<WechatQRStatusResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as WechatQRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

export async function runWechatQrFlow(): Promise<{ baseUrl: string; token: string } | null> {
  const qrResp = await fetchQRCode(DEFAULT_BASE_URL);

  try {
    const qrterm = await import('qrcode-terminal');
    await new Promise<void>(resolve => {
      qrterm.default.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log(`请在浏览器中打开此链接扫码: ${qrResp.qrcode_img_content}\n`);
  }

  console.log('请用微信扫描上方二维码...\n');

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let scannedPrinted = false;
  let currentPollUrl = DEFAULT_BASE_URL;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(currentPollUrl, qrResp.qrcode);

    switch (status.status) {
      case 'wait':
        process.stdout.write('.');
        break;
      case 'scaned':
        if (!scannedPrinted) {
          console.log('\n👀 已扫码，请在微信中确认...');
          scannedPrinted = true;
        }
        break;
      case 'scaned_but_redirect':
        if (status.redirect_host) {
          currentPollUrl = `https://${status.redirect_host}`;
        }
        break;
      case 'expired':
        console.error('\n二维码已过期');
        return null;
      case 'confirmed':
        if (!status.ilink_bot_id || !status.bot_token) {
          console.error('\n登录失败：服务器未返回完整信息');
          return null;
        }
        return {
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          token: status.bot_token,
        };
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n登录超时');
  return null;
}

export async function cmdInitWechat(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let aid: string | null = null;
  let agentConfig: AgentConfig | null = null;
  let choice: InstanceChoice | null = null;

  try {
    aid = await pickAgentForChannel(rl);
    if (!aid) return;

    agentConfig = loadAgent(aid);
    if (!agentConfig) {
      console.error(`❌ 无法加载 agent ${aid} 的配置`);
      return;
    }
    const existing = (agentConfig.channels || []).filter(c => c.type === 'wechat');
    choice = await pickInstanceWithinAgent(rl, 'wechat', existing);
    if (choice === null) return;
  } finally {
    rl.close();
  }

  console.log('\n正在获取微信登录二维码...\n');
  const result = await runWechatQrFlow();
  if (!result) {
    console.log('已取消');
    return;
  }

  const channel: ChannelInstance = {
    type: 'wechat',
    name: choice.name,
    enabled: true,
    baseUrl: result.baseUrl,
    token: result.token,
  } as ChannelInstance;

  await commitChannel(aid!, channel, choice.action);
}

// ==================== AUN ====================
//
// AUN 原子操作（aidCreate, agentmdPut, downloadCaRoot, isValidAid, ...）
// 已迁移至 src/channels/aun-ops.ts。本节仅保留交互式 UI 编排。

export async function checkAunEnvironment(rl: readline.Interface): Promise<boolean> {
  console.log('\n🔍 AUN 环境检查...\n');

  const minVer = MIN_AUN_CORE_SDK.join('.');
  const installed = resolveAunCoreSdkPkg();

  if (!installed) {
    console.log(`  ✗ ${AUN_CORE_SDK_PKG} 未安装`);
    const answer = (await ask(rl, `  → 是否安装 ${AUN_CORE_SDK_PKG}@latest？[Y/n] `)).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      console.log('  已取消');
      return false;
    }
    console.log(`  正在安装 ${AUN_CORE_SDK_PKG}...`);
    try {
      await npmInstallGlobal(`${AUN_CORE_SDK_PKG}@latest`);
      console.log(`  ✓ ${AUN_CORE_SDK_PKG} 安装完成`);
    } catch (e: any) {
      console.log(`  ✗ 安装失败: ${e.message?.slice(0, 200) || e}`);
      return false;
    }
    console.log('');
    return true;
  }

  if (isAunSdkVersionOk(installed.version)) {
    console.log(`  ✓ ${AUN_CORE_SDK_PKG} v${installed.version}`);
    console.log('');
    return true;
  }

  console.log(`  ✗ ${AUN_CORE_SDK_PKG} v${installed.version} — 需要 >= ${minVer}`);
  const answer = (await ask(rl, `  → 是否升级 ${AUN_CORE_SDK_PKG}？[Y/n] `)).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
    console.log('  已取消');
    return false;
  }
  console.log(`  正在升级 ${AUN_CORE_SDK_PKG}...`);
  try {
    await npmInstallGlobal(`${AUN_CORE_SDK_PKG}@latest`);
    console.log(`  ✓ ${AUN_CORE_SDK_PKG} 升级完成`);
  } catch (e: any) {
    console.log(`  ✗ 升级失败: ${e.message?.slice(0, 200) || e}`);
    return false;
  }
  console.log('');
  return true;
}

// isValidAid, createAidSilent → 已迁移至 src/channels/aun-ops.ts

// appendAunInstance → 已迁移至 src/channels/aun-ops.ts

export async function setupAunAid(rl: readline.Interface, _config: any): Promise<{ aid: string; owner: string } | null> {
  let aid = '';

  // Outer loop: allows retrying with a different AID
  while (true) {
    // Ask AID with format validation
    aid = '';
    while (!aid) {
      aid = (await ask(rl, '  AUN Agent ID (例: mybot.agentid.pub): ')).trim();
      if (!aid) { console.log('  ⚠ 不能为空'); continue; }
      if (!isValidAid(aid)) {
        console.log('  ⚠ 无效 AID 格式（需要合法域名，至少三级，如 alice.agentid.pub）');
        aid = '';
      }
    }

    // Check if AID exists locally
    const aunPath = path.join(os.homedir(), '.aun');
    const aidDir = path.join(aunPath, 'AIDs', aid);
    if (fs.existsSync(aidDir) && fs.existsSync(path.join(aidDir, 'private'))) {
      console.log(`  ✓ AID ${aid} 已存在`);
      break;
    }

    const answer = (await ask(rl, `  ⚠ AID ${aid} 本地不存在，是否创建？[Y/n] `)).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      console.log('  已跳过 AID 创建（启动时可能连接失败）');
      break;
    }

    // Create AID + agent.md via atomic ops
    console.log('  正在创建 AID...');
    let failed = false;
    try {
      const result = await aidCreate(aid);
      console.log(`  ✓ AID ${result.aid} 创建成功`);

      // Collect agent.md type and upload
      const typeInput = (await ask(rl, '  Agent 类型 human/ai [ai]: ')).trim().toLowerCase();
      const agentType = typeInput === 'human' ? 'human' : 'ai';
      const content = buildInitialAgentMd({ aid, type: agentType });

      try {
        await agentmdPut(content, { aid, client: result.client });
        console.log('  ✓ agent.md 已发布并写入本地');
      } catch (e: any) {
        console.log(`  ⚠ agent.md 发布失败（首次连接将自动重试）: ${String(e.message || e).slice(0, 100)}`);
        // Still write local copy as fallback
        try {
          fs.mkdirSync(aidDir, { recursive: true });
          fs.writeFileSync(path.join(aidDir, 'agent.md'), content, 'utf-8');
          console.log('  ✓ agent.md 已写入本地');
        } catch (we: any) {
          console.log(`  ✗ agent.md 本地写入失败: ${String(we.message || we).slice(0, 100)}`);
          failed = true;
        }
      }

      try { await result.client.close(); } catch { /* ignore */ }
    } catch (e: any) {
      const msg = e.message || String(e);
      console.log(`  ✗ AID 创建失败: ${msg.slice(0, 200)}`);
      failed = true;
    }

    if (!failed) break;

    // Creation failed — retry or give up
    const retry = (await ask(rl, '  → 重新输入 (r) / 跳过 (s) / 取消 (c)？[r/s/c] ')).trim().toLowerCase();
    if (retry === 'c') return null;
    if (retry === 's') break;
    // default: retry with new AID
  }

  // Owner 必填
  console.log('\n📋 Owner 配置');
  console.log('  Owner 将接收欢迎消息并拥有管理权限');
  let owner = '';
  while (!owner) {
    const ownerInput = (await ask(rl, '  Owner AID (必填): ')).trim();
    if (!ownerInput) { console.log('  ⚠ Owner AID 不能为空'); continue; }
    if (!isValidAid(ownerInput)) { console.log('  ⚠ Owner AID 格式无效'); continue; }
    owner = ownerInput;
    console.log(`  ✓ Owner 已设置: ${owner}`);
  }

  return { aid, owner };
}

// ==================== DingTalk ====================

const DINGTALK_BASE_URL = 'https://oapi.dingtalk.com';
const DINGTALK_SOURCE = 'openClaw';

interface DingtalkInitResponse {
  errcode: number;
  errmsg?: string;
  nonce?: string;
}

interface DingtalkBeginResponse {
  errcode: number;
  errmsg?: string;
  device_code?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface DingtalkPollResponse {
  errcode: number;
  errmsg?: string;
  status?: string;
  client_id?: string;
  client_secret?: string;
  fail_reason?: string;
}

interface DingtalkRegistrationResult {
  clientId: string;
  clientSecret: string;
}

async function dingtalkApiPost<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${DINGTALK_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`DingTalk API ${path} failed: ${res.status}`);
  const data = await res.json() as T & { errcode?: number; errmsg?: string };
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`DingTalk API ${path}: ${data.errmsg || 'unknown error'} (errcode=${data.errcode})`);
  }
  return data;
}

async function runDingtalkQrFlow(): Promise<DingtalkRegistrationResult | typeof SKIP | typeof QUIT> {
  // Step 1: init → nonce
  const initData = await dingtalkApiPost<DingtalkInitResponse>(
    '/app/registration/init', { source: DINGTALK_SOURCE }
  );
  const nonce = initData.nonce?.trim();
  if (!nonce) throw new Error('DingTalk init: 未返回 nonce');

  // Step 2: begin → device_code + verification_uri_complete
  const beginData = await dingtalkApiPost<DingtalkBeginResponse>(
    '/app/registration/begin', { nonce }
  );
  const deviceCode = beginData.device_code?.trim();
  const verificationUri = beginData.verification_uri_complete?.trim();
  if (!deviceCode) throw new Error('DingTalk begin: 未返回 device_code');
  if (!verificationUri) throw new Error('DingTalk begin: 未返回 verification_uri_complete');

  // Display QR code
  try {
    const qrterm = await import('qrcode-terminal');
    await new Promise<void>(resolve => {
      qrterm.default.generate(verificationUri, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log(`请在浏览器中打开此链接扫码: ${verificationUri}\n`);
  }

  console.log('请用钉钉扫描上方二维码...\n');
  console.log('提示: 扫码页面标注 "OpenClaw" 是钉钉生态接入桥，可放心使用。\n');
  console.log('按 q 退出 | 按 s 跳过扫码手动输入\n');

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
  const pollInterval = Math.max(Number(beginData.interval ?? 3), 2);
  const expiresIn = Number(beginData.expires_in ?? 7200);
  const startedAt = Date.now();

  try {
    while (Date.now() - startedAt < expiresIn * 1000) {
      if (userAction === QUIT) return QUIT;
      if (userAction === SKIP) return SKIP;

      await new Promise(r => setTimeout(r, pollInterval * 1000));

      const pollData = await dingtalkApiPost<DingtalkPollResponse>(
        '/app/registration/poll', { device_code: deviceCode }
      );

      const status = (pollData.status || '').trim().toUpperCase();

      if (status === 'SUCCESS') {
        if (!pollData.client_id || !pollData.client_secret) {
          throw new Error('授权成功但未返回凭据');
        }
        return {
          clientId: pollData.client_id.trim(),
          clientSecret: pollData.client_secret.trim(),
        };
      }

      if (status === 'WAITING') {
        continue;
      }

      if (status === 'EXPIRED') {
        throw new Error('扫码会话已过期');
      }

      if (status === 'FAIL') {
        throw new Error(`授权失败: ${pollData.fail_reason || '未知原因'}`);
      }

      // Unknown status — keep polling
    }

    throw new Error('等待扫码结果超时');
  } finally {
    cleanup();
  }
}

export async function runDingtalkQrFlowSimple(): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const result = await runDingtalkQrFlow();
    if (result === QUIT || result === SKIP) return null;
    return result;
  } catch (error) {
    console.error(`\n登录失败: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export async function cmdInitDingtalk(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let aid: string | null = null;
  let agentConfig: AgentConfig | null = null;
  let choice: InstanceChoice | null = null;

  try {
    aid = await pickAgentForChannel(rl);
    if (!aid) return;

    agentConfig = loadAgent(aid);
    if (!agentConfig) {
      console.error(`❌ 无法加载 agent ${aid} 的配置`);
      return;
    }
    const existing = (agentConfig.channels || []).filter(c => c.type === 'dingtalk');
    choice = await pickInstanceWithinAgent(rl, 'dingtalk', existing);
    if (choice === null) return;
  } finally {
    rl.close();
  }

  console.log('\n正在获取钉钉登录二维码...\n');

  let result: DingtalkRegistrationResult;
  try {
    const flowResult = await runDingtalkQrFlow();
    if (flowResult === QUIT) {
      console.log('已退出');
      return;
    }
    if (flowResult === SKIP) {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('\n手动输入模式：\n');
        let clientId = '';
        while (!clientId) {
          clientId = (await ask(rl2, '  钉钉 Client ID (AppKey): ')).trim();
          if (!clientId) console.log('  ⚠ 不能为空');
        }
        let clientSecret = '';
        while (!clientSecret) {
          clientSecret = (await ask(rl2, '  钉钉 Client Secret (AppSecret): ')).trim();
          if (!clientSecret) console.log('  ⚠ 不能为空');
        }
        result = { clientId, clientSecret };
      } finally {
        rl2.close();
      }
    } else {
      result = flowResult;
    }
  } catch (error) {
    console.error(`\n登录失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const channel: ChannelInstance = {
    type: 'dingtalk',
    name: choice.name,
    enabled: true,
    clientId: result.clientId,
    clientSecret: result.clientSecret,
  } as ChannelInstance;

  await commitChannel(aid!, channel, choice.action);
  console.log(`  Client ID: ${result.clientId}`);
}

// ==================== QQBot ====================

const QQBOT_PORTAL_HOST = 'q.qq.com';
const QQBOT_CREATE_PATH = '/lite/create_bind_task';
const QQBOT_POLL_PATH = '/lite/poll_bind_result';
const QQBOT_QR_TEMPLATE = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=hermes';
const QQBOT_POLL_INTERVAL_MS = 2000;
const QQBOT_POLL_TIMEOUT_MS = 600_000; // 10 minutes

const enum QQBotBindStatus {
  NONE = 0,
  PENDING = 1,
  COMPLETED = 2,
  EXPIRED = 3,
}

interface QQBotBindResult {
  appId: string;
  clientSecret: string;
}

function qqbotApiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json', // Required — without it, q.qq.com returns anti-bot HTML
    'User-Agent': 'EvolClaw/QQBotInit',
  };
}

function generateBindKey(): { keyBase64: string; keyBuffer: Buffer } {
  const keyBuffer = crypto.randomBytes(32);
  return { keyBase64: keyBuffer.toString('base64'), keyBuffer };
}

function decryptSecret(encryptedBase64: string, keyBuffer: Buffer): string {
  const raw = Buffer.from(encryptedBase64, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

async function runQQBotBindFlow(): Promise<QQBotBindResult | typeof SKIP | typeof QUIT> {
  // Step 1: Generate AES key and create bind task
  const { keyBase64, keyBuffer } = generateBindKey();

  const createRes = await fetch(`https://${QQBOT_PORTAL_HOST}${QQBOT_CREATE_PATH}`, {
    method: 'POST',
    headers: qqbotApiHeaders(),
    body: JSON.stringify({ key: keyBase64 }),
  });
  if (!createRes.ok) throw new Error(`create_bind_task failed: ${createRes.status}`);
  const createData = await createRes.json() as { retcode?: number; msg?: string; data?: { task_id?: string } };
  if (createData.retcode !== 0) {
    throw new Error(`create_bind_task: ${createData.msg || 'unknown error'}`);
  }
  const taskId = createData.data?.task_id;
  if (!taskId) throw new Error('create_bind_task: 未返回 task_id');

  // Step 2: Build QR URL and display
  const qrUrl = QQBOT_QR_TEMPLATE.replace('{task_id}', encodeURIComponent(taskId));

  try {
    const qrterm = await import('qrcode-terminal');
    await new Promise<void>(resolve => {
      qrterm.default.generate(qrUrl, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    console.log(`请在浏览器中打开此链接扫码: ${qrUrl}\n`);
  }

  console.log('请用 QQ 扫描上方二维码绑定机器人...\n');
  console.log('按 q 退出 | 按 s 跳过扫码手动输入\n');

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

  try {
    // Step 3: Poll for bind result
    while (Date.now() - startedAt < QQBOT_POLL_TIMEOUT_MS) {
      if (userAction === QUIT) return QUIT;
      if (userAction === SKIP) return SKIP;

      await new Promise(r => setTimeout(r, QQBOT_POLL_INTERVAL_MS));

      const pollRes = await fetch(`https://${QQBOT_PORTAL_HOST}${QQBOT_POLL_PATH}`, {
        method: 'POST',
        headers: qqbotApiHeaders(),
        body: JSON.stringify({ task_id: taskId }),
      });
      if (!pollRes.ok) continue; // transient error, keep polling

      const pollData = await pollRes.json() as {
        retcode?: number;
        msg?: string;
        data?: { status?: number; bot_appid?: string; bot_encrypt_secret?: string; user_openid?: string };
      };
      if (pollData.retcode !== 0) continue;

      const status = pollData.data?.status ?? QQBotBindStatus.NONE;

      if (status === QQBotBindStatus.COMPLETED) {
        const botAppId = pollData.data?.bot_appid;
        const encryptedSecret = pollData.data?.bot_encrypt_secret;
        if (!botAppId || !encryptedSecret) {
          throw new Error('绑定成功但未返回完整凭据');
        }

        // Step 4: Decrypt the secret
        const clientSecret = decryptSecret(encryptedSecret, keyBuffer);

        return { appId: botAppId, clientSecret };
      }

      if (status === QQBotBindStatus.EXPIRED) {
        throw new Error('二维码已过期');
      }

      // NONE or PENDING — keep polling
    }

    throw new Error('等待扫码结果超时');
  } finally {
    cleanup();
  }
}

export async function runQQBotBindFlowSimple(): Promise<{ appId: string; clientSecret: string } | null> {
  try {
    const result = await runQQBotBindFlow();
    if (result === QUIT || result === SKIP) return null;
    return result;
  } catch (error) {
    console.error(`\n绑定失败: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export async function cmdInitQQBot(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let aid: string | null = null;
  let agentConfig: AgentConfig | null = null;
  let choice: InstanceChoice | null = null;

  try {
    aid = await pickAgentForChannel(rl);
    if (!aid) return;

    agentConfig = loadAgent(aid);
    if (!agentConfig) {
      console.error(`❌ 无法加载 agent ${aid} 的配置`);
      return;
    }
    const existing = (agentConfig.channels || []).filter(c => c.type === 'qqbot');
    choice = await pickInstanceWithinAgent(rl, 'qqbot', existing);
    if (choice === null) return;
  } finally {
    rl.close();
  }

  console.log('\n正在创建 QQ 机器人绑定任务...\n');

  let result: QQBotBindResult;
  try {
    const flowResult = await runQQBotBindFlow();
    if (flowResult === QUIT) {
      console.log('已退出');
      return;
    }
    if (flowResult === SKIP) {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('\n手动输入模式：\n');
        let appId = '';
        while (!appId) {
          appId = (await ask(rl2, '  QQ 机器人 App ID: ')).trim();
          if (!appId) console.log('  ⚠ 不能为空');
        }
        let clientSecret = '';
        while (!clientSecret) {
          clientSecret = (await ask(rl2, '  QQ 机器人 Client Secret: ')).trim();
          if (!clientSecret) console.log('  ⚠ 不能为空');
        }
        result = { appId, clientSecret };
      } finally {
        rl2.close();
      }
    } else {
      result = flowResult;
    }
  } catch (error) {
    console.error(`\n绑定失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const channel: ChannelInstance = {
    type: 'qqbot',
    name: choice.name,
    enabled: true,
    appId: result.appId,
    clientSecret: result.clientSecret,
  } as ChannelInstance;

  await commitChannel(aid!, channel, choice.action);
  console.log(`  App ID: ${result.appId}`);
}

// ==================== WeCom (企业微信) ====================

export async function cmdInitWecom(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let aid: string | null = null;
  let agentConfig: AgentConfig | null = null;
  let choice: InstanceChoice | null = null;
  let botId = '';
  let secret = '';

  try {
    aid = await pickAgentForChannel(rl);
    if (!aid) return;

    agentConfig = loadAgent(aid);
    if (!agentConfig) {
      console.error(`❌ 无法加载 agent ${aid} 的配置`);
      return;
    }
    const existing = (agentConfig.channels || []).filter(c => c.type === 'wecom');
    choice = await pickInstanceWithinAgent(rl, 'wecom', existing);
    if (choice === null) return;

    console.log('\n企业微信 AI Bot 配置');
    console.log('请在企业微信管理后台 → AI Bot 页面获取 Bot ID 和 Secret\n');
    while (!botId) {
      botId = (await ask(rl, '  Bot ID: ')).trim();
      if (!botId) console.log('  ⚠ 不能为空');
    }
    while (!secret) {
      secret = (await ask(rl, '  Secret: ')).trim();
      if (!secret) console.log('  ⚠ 不能为空');
    }
  } finally {
    rl.close();
  }

  const channel: ChannelInstance = {
    type: 'wecom',
    name: choice.name,
    enabled: true,
    botId,
    secret,
  } as ChannelInstance;

  await commitChannel(aid!, channel, choice.action);
  console.log(`  Bot ID: ${botId}`);
}

// ==================== Shared helpers for per-agent init <channel> ====================

/**
 * Pick the target agent for an `evolclaw init <channel>` flow.
 *
 * - 0 agents → print guidance and return null
 * - ≥1 → letter menu; with 1 agent the prompt accepts Enter (defaults to 'a')
 */
async function pickAgentForChannel(rl: readline.Interface): Promise<string | null> {
  const { agents } = loadAllAgents();
  if (agents.length === 0) {
    console.log('❌ 暂无 agent，请先创建：');
    console.log('     evolclaw agent new <aid>.agentid.pub');
    return null;
  }

  const letters = 'abcdefghijklmnopqrstuvwxyz';
  console.log(`共 ${agents.length} 个 agent：`);
  for (let i = 0; i < agents.length; i++) {
    console.log(`  ${letters[i]}. ${agents[i].aid}`);
  }

  const valid = letters.slice(0, agents.length).split('');
  const promptSuffix = agents.length === 1 ? ' [a]' : '';
  let choice = '';
  while (!valid.includes(choice)) {
    choice = (await ask(rl, `请选择${promptSuffix}: `)).trim().toLowerCase();
    if (agents.length === 1 && choice === '') choice = 'a';
    if (!valid.includes(choice)) {
      console.log(`无效选择，请输入 ${valid.join('/')}`);
    }
  }
  return agents[letters.indexOf(choice)].aid;
}

/**
 * Pick "add new instance" or "overwrite existing instance" within a single agent
 * for the given channel type. Returns null if user cancels.
 *
 * If existing.length === 0 → returns { action:'add', name:'main' } directly.
 */
async function pickInstanceWithinAgent(
  rl: readline.Interface,
  channelType: string,
  existing: ChannelInstance[],
): Promise<InstanceChoice | null> {
  if (existing.length === 0) {
    return { action: 'add', name: 'main' };
  }
  const view = existing.map((c, i) => ({ ...(c as any), name: c.name, originalIndex: i }));
  return await selectInstance(rl, channelType, view);
}

/**
 * Persist the new/overwritten channel and trigger hot-reload.
 */
async function commitChannel(
  aid: string,
  channel: ChannelInstance,
  mode: 'add' | 'overwrite',
): Promise<void> {
  const result = await agentChannelUpsert({ aid, channel, mode });
  if (result.ok !== true) {
    console.error(`❌ ${(result as any).error || 'channel upsert failed'}`);
    return;
  }
  console.log(`\n✓ 已写入 agents/${aid}/config.json`);
  console.log(result.reloaded
    ? '  ✓ 已热重载'
    : '  ⚠ 服务未运行（或热重载失败），下次 evolclaw start 时生效');
}

// ==================== Unified Credential Collector Dispatcher ====================

/**
 * Returns the credential collector function for a given channel type.
 * Used by `evolclaw agent new` to collect credentials for agent config.
 *
 * Each collector is an async function that runs the interactive flow and returns
 * the credential object (same shape as a channel instance in config.json),
 * or null if the user cancels.
 */
export type ChannelCredentialCollector = () => Promise<Record<string, any> | null>;

export function getChannelCredentialCollector(type: string): ChannelCredentialCollector | null {
  switch (type) {
    case 'feishu':
      return async () => {
        const result = await runFeishuQrFlow();
        if (!result) return null;
        return { appId: result.appId, appSecret: result.appSecret, enabled: true };
      };
    case 'wechat':
      return async () => {
        const result = await runWechatQrFlow();
        if (!result) return null;
        return { baseUrl: result.baseUrl, token: result.token, enabled: true };
      };
    case 'dingtalk':
      return async () => {
        const result = await runDingtalkQrFlowSimple();
        if (!result) return null;
        return { clientId: result.clientId, clientSecret: result.clientSecret, enabled: true };
      };
    case 'qqbot':
      return async () => {
        const result = await runQQBotBindFlowSimple();
        if (!result) return null;
        return { appId: result.appId, clientSecret: result.clientSecret, enabled: true };
      };
    case 'wecom':
      return async () => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
        try {
          console.log('企业微信 AI Bot 配置\n');
          console.log('请在企业微信管理后台 → AI Bot 页面获取 Bot ID 和 Secret\n');

          const botId = (await ask('  Bot ID: ')).trim();
          if (!botId) return null;
          const secret = (await ask('  Secret: ')).trim();
          if (!secret) return null;
          return { botId, secret, enabled: true };
        } finally {
          rl.close();
        }
      };
    default:
      return null;
  }
}

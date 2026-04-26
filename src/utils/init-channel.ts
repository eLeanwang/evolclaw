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
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolvePaths } from '../paths.js';
import { normalizeChannelInstances } from '../config.js';
import { selectInstance, type InstanceChoice } from './init.js';
import { isWindows } from './cross-platform.js';

const execFileAsync = promisify(execFile);

async function npmInstallGlobal(pkg: string): Promise<void> {
  try {
    await execFileAsync('npm', ['install', '-g', pkg], { timeout: 180000 });
  } catch (e: any) {
    if (e.stderr?.includes('EACCES') || e.message?.includes('EACCES')) {
      if (isWindows) {
        throw new Error('权限不足。请以管理员身份运行 PowerShell 或 CMD，然后重试');
      }
      await execFileAsync('sudo', ['npm', 'install', '-g', pkg], { timeout: 180000 });
    } else {
      throw e;
    }
  }
}

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
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
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

  while (Date.now() < deadline) {
    const status = await pollQRStatus(DEFAULT_BASE_URL, qrResp.qrcode);

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
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log(`❌ 配置文件不存在，请先运行 evolclaw init`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  // Normalize existing instances and filter out placeholders
  const allInstances = normalizeChannelInstances(config.channels?.wechat, 'wechat');
  const validInstances: Array<{ name: string; originalIndex: number; [key: string]: any }> = [];
  for (let i = 0; i < allInstances.length; i++) {
    const inst = allInstances[i];
    if (!inst.token) continue;
    if (inst.token.includes('your-') || inst.token.includes('placeholder')) continue;
    validInstances.push({ ...inst, originalIndex: i });
  }

  let choice: InstanceChoice | null = null;

  if (validInstances.length > 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      choice = await selectInstance(rl, 'wechat', validInstances);
      if (choice === null) return; // user cancelled
    } finally {
      rl.close();
    }
  }

  console.log('正在获取微信登录二维码...\n');

  const qrResp = await fetchQRCode(DEFAULT_BASE_URL);

  // 终端显示二维码
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

  while (Date.now() < deadline) {
    const status = await pollQRStatus(DEFAULT_BASE_URL, qrResp.qrcode);

    switch (status.status) {
      case 'wait':
        process.stdout.write('.');
        break;
      case 'scaned':
        if (!scannedPrinted) {
          console.log('\n\ud83d\udc40 已扫码，请在微信中确认...');
          scannedPrinted = true;
        }
        break;
      case 'expired':
        console.log('\n二维码已过期，请重新运行 evolclaw init wechat');
        process.exit(1);
        break;
      case 'confirmed': {
        if (!status.ilink_bot_id || !status.bot_token) {
          console.error('\n登录失败：服务器未返回完整信息');
          process.exit(1);
        }

        const baseUrl = status.baseurl || DEFAULT_BASE_URL;
        const token = status.bot_token;

        // Write config to the correct slot
        if (!config.channels) config.channels = {};

        if (choice && choice.action === 'overwrite' && Array.isArray(config.channels.wechat)) {
          // Overwrite existing instance in array — use originalIndex to find the right slot
          const idx = validInstances[choice.index]?.originalIndex ?? choice.index;
          config.channels.wechat[idx].enabled = true;
          config.channels.wechat[idx].baseUrl = baseUrl;
          config.channels.wechat[idx].token = token;
        } else if (choice && choice.action === 'overwrite' && !Array.isArray(config.channels.wechat)) {
          // Overwrite single-object
          config.channels.wechat = config.channels.wechat || {};
          config.channels.wechat.enabled = true;
          config.channels.wechat.baseUrl = baseUrl;
          config.channels.wechat.token = token;
        } else if (choice && choice.action === 'add') {
          // Add new instance — upgrade to array if needed
          const newInst = {
            name: choice.name,
            enabled: true,
            baseUrl,
            token,
          };
          if (Array.isArray(config.channels.wechat)) {
            config.channels.wechat.push(newInst);
          } else if (config.channels.wechat) {
            // Upgrade single object to array
            const oldInst = { ...config.channels.wechat, name: config.channels.wechat.name || 'wechat' };
            config.channels.wechat = [oldInst, newInst];
          } else {
            config.channels.wechat = [newInst];
          }
        } else {
          // First instance — single object format (backward compat)
          config.channels.wechat = {
            enabled: true,
            baseUrl,
            token,
          };
        }

        if (!config.channels.defaultChannel) config.channels.defaultChannel = 'wechat';

        fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');

        console.log(`\n✅ 微信连接成功！`);
        console.log(`  Bot ID: ${status.ilink_bot_id}`);
        console.log(`  User ID: ${status.ilink_user_id}`);
        if (choice) {
          console.log(`  实例: ${choice.name} (${choice.action === 'add' ? '新增' : '覆盖'})`);
        }
        console.log(`  配置已写入: ${p.config}`);
        console.log(`\n现在可以启动服务: evolclaw restart`);
        return;
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n登录超时，请重新运行');
  process.exit(1);
}

// ==================== AUN ====================

// 最低 @eleans/aun-core-sdk 版本要求
const MIN_AUN_CORE_SDK = [0, 2, 9] as const;
const AUN_CORE_SDK_PKG = '@eleans/aun-core-sdk';

function compareVersion(a: string, min: readonly [number, number, number]): boolean {
  const parts = a.split('.').map(n => parseInt(n, 10));
  if (parts.length < 3 || parts.some(isNaN)) return false;
  if (parts[0] !== min[0]) return parts[0] > min[0];
  if (parts[1] !== min[1]) return parts[1] > min[1];
  return parts[2] >= min[2];
}

function resolveAunCoreSdkPkg(): { version: string; path: string } | null {
  try {
    const esmRequire = createRequire(import.meta.url);
    const entry = esmRequire.resolve(AUN_CORE_SDK_PKG);
    const pkgPath = path.join(path.dirname(entry), 'package.json');
    if (!fs.existsSync(pkgPath)) {
      // 向上回溯查找 package.json
      let dir = path.dirname(entry);
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)) {
          const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
          if (data.name === AUN_CORE_SDK_PKG) return { version: data.version, path: candidate };
        }
        dir = path.dirname(dir);
      }
      return null;
    }
    const data = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return { version: data.version, path: pkgPath };
  } catch {
    return null;
  }
}

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

  if (compareVersion(installed.version, MIN_AUN_CORE_SDK)) {
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

function isValidAid(name: string): boolean {
  const labels = name.split('.');
  return labels.length >= 3 && labels.every(l => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l));
}

export async function setupAunAid(rl: readline.Interface, _config: any): Promise<{ aid: string } | null> {
  let aid = '';
  let gatewayPort: number | undefined;  // only used locally for AID creation, not written to config

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

    const portStr = (await ask(rl, '  Gateway 端口 [留空使用默认 443]: ')).trim();
    gatewayPort = portStr ? parseInt(portStr, 10) : undefined;
    if (gatewayPort !== undefined && (isNaN(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)) {
      console.log('  ⚠ 端口号无效，使用默认 443');
      gatewayPort = undefined;
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

    // Create AID using TS SDK directly
    console.log('  正在创建 AID...');
    let failed = false;
    try {
      const { AUNClient } = await import('@eleans/aun-core-sdk');
      const client = new AUNClient({ aun_path: aunPath });

      // Set gateway URL from AID domain + port
      const domain = aid.split('.').slice(1).join('.');
      const port = gatewayPort || 443;
      (client as any)._gatewayUrl = `wss://gateway.${domain}:${port}/aun`;

      const result = await client.auth.createAid({ aid });
      console.log(`  ✓ AID ${result.aid} 创建成功`);
      try { await client.close(); } catch { /* ignore */ }
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

  return { aid };
}

export async function cmdInitAun(): Promise<void> {
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log('❌ 配置文件不存在，请先运行 evolclaw init');
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (config.channels?.aun?.aid) {
      const answer = (await ask(rl, '已有 AUN 配置，是否重新配置？[y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('已取消');
        return;
      }
    }

    if (!await checkAunEnvironment(rl)) {
      return;
    }

    const result = await setupAunAid(rl, config);
    if (!result) return;

    if (!config.channels) config.channels = {};
    config.channels.aun = {
      enabled: true,
      aid: result.aid,
    };
    if (!config.channels.defaultChannel) config.channels.defaultChannel = 'aun';

    fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');
    console.log('\n✓ AUN 配置已写入');
  } finally {
    rl.close();
  }
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
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log('❌ 配置文件不存在，请先运行 evolclaw init');
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  // Normalize existing instances and filter out placeholders
  const allInstances = normalizeChannelInstances(config.channels?.dingtalk, 'dingtalk');
  const validInstances: Array<{ name: string; originalIndex: number; [key: string]: any }> = [];
  for (let i = 0; i < allInstances.length; i++) {
    const inst = allInstances[i];
    if (!inst.clientId || !inst.clientSecret) continue;
    if (inst.clientId.includes('your-') || inst.clientId.includes('placeholder')) continue;
    if (inst.clientSecret.includes('your-') || inst.clientSecret.includes('placeholder')) continue;
    validInstances.push({ ...inst, originalIndex: i });
  }

  let choice: InstanceChoice | null = null;

  if (validInstances.length > 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      choice = await selectInstance(rl, 'dingtalk', validInstances);
      if (choice === null) return;
    } finally {
      rl.close();
    }
  }

  console.log('正在获取钉钉登录二维码...\n');

  let result: DingtalkRegistrationResult;
  try {
    const flowResult = await runDingtalkQrFlow();

    if (flowResult === QUIT) {
      console.log('已退出');
      return;
    }

    if (flowResult === SKIP) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('\n手动输入模式：\n');
        let clientId = '';
        while (!clientId) {
          clientId = (await ask(rl, '  钉钉 Client ID (AppKey): ')).trim();
          if (!clientId) console.log('  ⚠ 不能为空');
        }
        let clientSecret = '';
        while (!clientSecret) {
          clientSecret = (await ask(rl, '  钉钉 Client Secret (AppSecret): ')).trim();
          if (!clientSecret) console.log('  ⚠ 不能为空');
        }
        result = { clientId, clientSecret };
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

  if (choice && choice.action === 'overwrite' && Array.isArray(config.channels.dingtalk)) {
    const idx = validInstances[choice.index]?.originalIndex ?? choice.index;
    config.channels.dingtalk[idx].clientId = result.clientId;
    config.channels.dingtalk[idx].clientSecret = result.clientSecret;
    config.channels.dingtalk[idx].enabled = true;
  } else if (choice && choice.action === 'overwrite' && !Array.isArray(config.channels.dingtalk)) {
    config.channels.dingtalk = config.channels.dingtalk || {};
    config.channels.dingtalk.clientId = result.clientId;
    config.channels.dingtalk.clientSecret = result.clientSecret;
    config.channels.dingtalk.enabled = true;
  } else if (choice && choice.action === 'add') {
    const newInst = {
      name: choice.name,
      clientId: result.clientId,
      clientSecret: result.clientSecret,
      enabled: true,
    };
    if (Array.isArray(config.channels.dingtalk)) {
      config.channels.dingtalk.push(newInst);
    } else if (config.channels.dingtalk) {
      const oldInst = { ...config.channels.dingtalk, name: config.channels.dingtalk.name || 'dingtalk' };
      config.channels.dingtalk = [oldInst, newInst];
    } else {
      config.channels.dingtalk = [newInst];
    }
  } else {
    config.channels.dingtalk = {
      clientId: result.clientId,
      clientSecret: result.clientSecret,
      enabled: true,
    };
  }

  if (!config.channels.defaultChannel) config.channels.defaultChannel = 'dingtalk';

  fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');

  console.log(`\n✅ 钉钉连接成功！`);
  console.log(`  Client ID: ${result.clientId}`);
  if (choice) {
    console.log(`  实例: ${choice.name} (${choice.action === 'add' ? '新增' : '覆盖'})`);
  }
  console.log(`  配置已写入: ${p.config}`);
  console.log(`\n现在可以启动服务: evolclaw restart`);
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
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log('❌ 配置文件不存在，请先运行 evolclaw init');
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  // Normalize existing instances and filter out placeholders
  const allInstances = normalizeChannelInstances(config.channels?.qqbot, 'qqbot');
  const validInstances: Array<{ name: string; originalIndex: number; [key: string]: any }> = [];
  for (let i = 0; i < allInstances.length; i++) {
    const inst = allInstances[i];
    if (!inst.appId || !inst.clientSecret) continue;
    if (inst.appId.includes('your-') || inst.appId.includes('placeholder')) continue;
    if (inst.clientSecret.includes('your-') || inst.clientSecret.includes('placeholder')) continue;
    validInstances.push({ ...inst, originalIndex: i });
  }

  let choice: InstanceChoice | null = null;

  if (validInstances.length > 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      choice = await selectInstance(rl, 'qqbot', validInstances);
      if (choice === null) return;
    } finally {
      rl.close();
    }
  }

  console.log('正在创建 QQ 机器人绑定任务...\n');

  let result: QQBotBindResult;
  try {
    const flowResult = await runQQBotBindFlow();

    if (flowResult === QUIT) {
      console.log('已退出');
      return;
    }

    if (flowResult === SKIP) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('\n手动输入模式：\n');
        let appId = '';
        while (!appId) {
          appId = (await ask(rl, '  QQ 机器人 App ID: ')).trim();
          if (!appId) console.log('  ⚠ 不能为空');
        }
        let clientSecret = '';
        while (!clientSecret) {
          clientSecret = (await ask(rl, '  QQ 机器人 Client Secret: ')).trim();
          if (!clientSecret) console.log('  ⚠ 不能为空');
        }
        result = { appId, clientSecret };
      } finally {
        rl.close();
      }
    } else {
      result = flowResult;
    }
  } catch (error) {
    console.error(`\n绑定失败: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Write config to the correct slot
  if (!config.channels) config.channels = {};

  if (choice && choice.action === 'overwrite' && Array.isArray(config.channels.qqbot)) {
    const idx = validInstances[choice.index]?.originalIndex ?? choice.index;
    config.channels.qqbot[idx].appId = result.appId;
    config.channels.qqbot[idx].clientSecret = result.clientSecret;
    config.channels.qqbot[idx].enabled = true;
  } else if (choice && choice.action === 'overwrite' && !Array.isArray(config.channels.qqbot)) {
    config.channels.qqbot = config.channels.qqbot || {};
    config.channels.qqbot.appId = result.appId;
    config.channels.qqbot.clientSecret = result.clientSecret;
    config.channels.qqbot.enabled = true;
  } else if (choice && choice.action === 'add') {
    const newInst = {
      name: choice.name,
      appId: result.appId,
      clientSecret: result.clientSecret,
      enabled: true,
    };
    if (Array.isArray(config.channels.qqbot)) {
      config.channels.qqbot.push(newInst);
    } else if (config.channels.qqbot) {
      const oldInst = { ...config.channels.qqbot, name: config.channels.qqbot.name || 'qqbot' };
      config.channels.qqbot = [oldInst, newInst];
    } else {
      config.channels.qqbot = [newInst];
    }
  } else {
    config.channels.qqbot = {
      appId: result.appId,
      clientSecret: result.clientSecret,
      enabled: true,
    };
  }

  if (!config.channels.defaultChannel) config.channels.defaultChannel = 'qqbot';

  fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');

  console.log(`\n✅ QQ 机器人绑定成功！`);
  console.log(`  App ID: ${result.appId}`);
  if (choice) {
    console.log(`  实例: ${choice.name} (${choice.action === 'add' ? '新增' : '覆盖'})`);
  }
  console.log(`  配置已写入: ${p.config}`);
  console.log(`\n现在可以启动服务: evolclaw restart`);
}

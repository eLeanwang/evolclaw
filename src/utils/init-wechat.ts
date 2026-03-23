import crypto from 'node:crypto';
import fs from 'fs';
import readline from 'readline';
import { resolvePaths } from '../paths.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const QR_POLL_TIMEOUT_MS = 35_000;
const LOGIN_TIMEOUT_MS = 480_000;

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
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
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  }
}

export async function cmdInitWechat(): Promise<void> {
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log(`❌ 配置文件不存在，请先运行 evolclaw init`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  // 检查已有配置
  if (config.wechat?.token) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await ask(rl, '已有微信配置，是否重新登录？[y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('已取消');
        return;
      }
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
          console.log('\n👀 已扫码，请在微信中确认...');
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

        // 写入配置
        config.wechat = {
          enabled: true,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          token: status.bot_token,
        };

        fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');

        console.log(`\n✅ 微信连接成功！`);
        console.log(`  Bot ID: ${status.ilink_bot_id}`);
        console.log(`  User ID: ${status.ilink_user_id}`);
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

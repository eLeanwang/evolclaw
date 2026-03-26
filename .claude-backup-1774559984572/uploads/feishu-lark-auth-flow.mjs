#!/usr/bin/env node

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import process from "node:process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export const SKIP = Symbol("SKIP");
export const QUIT = Symbol("QUIT");

export const FEISHU_ENV_URLS = {
  prod: "https://accounts.feishu.cn",
  boe: "https://accounts.feishu-boe.cn",
  pre: "https://accounts.feishu-pre.cn",
};

export const LARK_ENV_URLS = {
  prod: "https://accounts.larksuite.com",
  boe: "https://accounts.larksuite-boe.com",
  pre: "https://accounts.larksuite-pre.com",
};

function assertKnownEnv(env) {
  if (!(env in FEISHU_ENV_URLS)) {
    throw new Error(`不支持的环境: ${env}`);
  }
}

function buildHeaders(lane) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (lane) {
    headers.set("x-tt-env", lane);
  }
  return headers;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`响应不是合法 JSON: ${text}`);
  }
}

export function printQRCode(url, renderer = null) {
  if (renderer) {
    renderer(url);
    return;
  }
  try {
    const qr = require("qrcode-terminal");
    qr.generate(url, { small: true });
  } catch {
    process.stdout.write(`${url}\n`);
  }
}

export class FeishuQrRegistrationClient {
  constructor(options = {}) {
    const env = options.env ?? "prod";
    assertKnownEnv(env);
    this.env = env;
    this.debug = Boolean(options.debug);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("当前运行环境没有 fetch，可通过 options.fetchImpl 注入。");
    }
    this.lane = options.lane ?? "";
    this.setDomain(false);
  }

  setDomain(isLark) {
    const baseUrls = isLark ? LARK_ENV_URLS : FEISHU_ENV_URLS;
    this.baseUrl = baseUrls[this.env];
  }

  async init() {
    return await this.#postRegistration({
      action: "init",
      tolerateHttpError: false,
    });
  }

  async begin() {
    return await this.#postRegistration({
      action: "begin",
      tolerateHttpError: false,
      extraParams: {
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id",
      },
    });
  }

  async poll(deviceCode) {
    return await this.#postRegistration({
      action: "poll",
      tolerateHttpError: true,
      extraParams: {
        device_code: deviceCode,
      },
    });
  }

  async #postRegistration({ action, extraParams = {}, tolerateHttpError }) {
    const body = new URLSearchParams({
      action,
      ...extraParams,
    }).toString();
    const response = await this.fetchImpl(`${this.baseUrl}/oauth/v1/app/registration`, {
      method: "POST",
      headers: buildHeaders(this.lane),
      body,
    });
    const data = await parseResponseBody(response);
    if (this.debug) {
      console.error(
        JSON.stringify(
          {
            action,
            baseUrl: this.baseUrl,
            status: response.status,
            data,
          },
          null,
          2,
        ),
      );
    }
    if (!response.ok && !tolerateHttpError) {
      throw new Error(`请求失败: ${response.status} ${JSON.stringify(data)}`);
    }
    return data;
  }
}

export async function runQrRegistrationFlow(options = {}) {
  const client = new FeishuQrRegistrationClient(options);
  const now = options.now ?? (() => Date.now());
  const qrRenderer = options.qrRenderer ?? null;

  const initResult = await client.init();
  const authMethods = Array.isArray(initResult.supported_auth_methods)
    ? initResult.supported_auth_methods
    : [];
  if (!authMethods.includes("client_secret")) {
    throw new Error("当前环境不支持 client_secret 注册。");
  }

  const beginResult = await client.begin();
  if (!beginResult.verification_uri_complete) {
    throw new Error("服务端没有返回扫码链接 verification_uri_complete。");
  }
  if (!beginResult.device_code) {
    throw new Error("服务端没有返回 device_code。");
  }

  printQRCode(beginResult.verification_uri_complete, qrRenderer);

  const onKey = options.onKey ?? null;
  let userAction = null;
  let wakeUp = () => {};

  function setAction(action) {
    userAction = action;
    wakeUp();
  }

  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  const sleepFn = options.sleep ?? interruptibleSleep;

  function startKeyListener() {
    if (onKey) return () => {};
    if (!process.stdin.isTTY) return () => {};
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const handler = (key) => {
      if (key === "q" || key === "\u0003") setAction(QUIT);
      if (key === "s") setAction(SKIP);
    };
    process.stdin.on("data", handler);
    process.stdout.write("\n按 q 退出 | 按 s 跳过扫码手动输入 appId/appSecret\n\n");
    return () => {
      process.stdin.removeListener("data", handler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  }

  const stopKeyListener = startKeyListener();

  if (onKey) {
    onKey(setAction);
  }

  const startedAt = now();
  let pollIntervalSeconds = Number(beginResult.interval ?? 5);
  const expireInSeconds = Number(beginResult.expires_in ?? beginResult.expire_in ?? 600);
  let domainResolved = false;
  let currentDomain = "feishu";

  try {
    while (now() - startedAt < expireInSeconds * 1000) {
      if (userAction === QUIT) {
        stopKeyListener();
        return QUIT;
      }
      if (userAction === SKIP) {
        stopKeyListener();
        return SKIP;
      }

      const pollResult = await client.poll(beginResult.device_code);

      if (pollResult.user_info?.tenant_brand === "lark" && !domainResolved) {
        client.setDomain(true);
        currentDomain = "lark";
        domainResolved = true;
      }

      if (pollResult.client_id && pollResult.client_secret) {
        return {
          appId: pollResult.client_id,
          appSecret: pollResult.client_secret,
          domain: currentDomain,
          userInfo: {
            openId: pollResult.user_info?.open_id ?? "",
          },
        };
      }

      if (domainResolved && pollResult.user_info?.tenant_brand === "lark") {
        continue;
      }

      if (pollResult.error === "authorization_pending") {
        await sleepFn(pollIntervalSeconds * 1000);
        continue;
      }

      if (pollResult.error === "slow_down") {
        pollIntervalSeconds += 5;
        await sleepFn(pollIntervalSeconds * 1000);
        continue;
      }

      if (pollResult.error === "access_denied") {
        throw new Error("用户拒绝了扫码授权。");
      }

      if (pollResult.error === "expired_token") {
        throw new Error("扫码会话已过期。");
      }

      if (pollResult.error) {
        throw new Error(
          `扫码注册失败: ${pollResult.error}${pollResult.error_description ? ` - ${pollResult.error_description}` : ""}`,
        );
      }

      await sleepFn(pollIntervalSeconds * 1000);
    }

    throw new Error("等待扫码结果超时。");
  } finally {
    stopKeyListener();
  }
}

function parseCliArgs(argv) {
  const args = {
    env: "prod",
    lane: "",
    debug: false,
    json: false,
    qr: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") {
      args.env = argv[i + 1] ?? args.env;
      i += 1;
      continue;
    }
    if (arg === "--lane") {
      args.lane = argv[i + 1] ?? args.lane;
      i += 1;
      continue;
    }
    if (arg === "--debug") {
      args.debug = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--no-qr") {
      args.qr = false;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "用法:",
      "  node scripts/feishu-lark-auth-flow.mjs [--env prod|boe|pre] [--lane <lane>] [--debug] [--json] [--no-qr]",
      "",
      "说明:",
      "  提取自 openclaw-lark-tools 的飞书/Lark 扫码注册流程。",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function manualInput() {
  process.stdout.write("\n手动输入模式:\n");
  const appId = await prompt("appId: ");
  const appSecret = await prompt("appSecret: ");
  if (!appId || !appSecret) {
    throw new Error("appId 和 appSecret 不能为空。");
  }
  return { appId, appSecret, domain: "unknown", userInfo: { openId: "" } };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "扫码注册成功:",
      `appId: ${result.appId}`,
      `appSecret: ${result.appSecret}`,
      `domain: ${result.domain}`,
      `openId: ${result.userInfo.openId}`,
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const result = await runQrRegistrationFlow({
    env: args.env,
    lane: args.lane,
    debug: args.debug,
    qrRenderer: args.qr ? null : () => {},
  });

  if (result === QUIT) {
    process.stdout.write("已退出。\n");
    return;
  }

  if (result === SKIP) {
    const manual = await manualInput();
    printResult(manual, args.json);
    return;
  }

  printResult(result, args.json);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

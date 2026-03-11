import { query, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync } from "fs";
import { join } from "path";

const TEST_DIR = "./test-results";
const logFile = join(TEST_DIR, "edge-cases.log");

function log(msg: string) {
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
  console.log(msg);
}

// 测试 1: 权限请求场景
async function testPermissionRequest() {
  log("\n=== 测试 1: 权限请求场景 ===");
  
  const permissionHook: HookCallback = async (input) => {
    log(`[PermissionRequest Hook] ${JSON.stringify(input, null, 2)}`);
    return {};
  };

  const stopHook: HookCallback = async (input) => {
    log(`[Stop Hook] session=${input.session_id.substring(0, 8)}`);
    return {};
  };

  try {
    for await (const message of query({
      prompt: "创建一个测试文件 test.txt，内容为 'hello'",
      options: {
        cwd: process.cwd(),
        allowedTools: ["Write"],
        permissionMode: "default", // 需要权限确认
        hooks: {
          PermissionRequest: [{ hooks: [permissionHook] }],
          Stop: [{ hooks: [stopHook] }],
        },
      },
    })) {
      if ("result" in message) {
        log(`结果: ${message.result.substring(0, 100)}`);
      }
    }
  } catch (error) {
    log(`错误: ${error}`);
  }
}

// 测试 2: 工具执行失败
async function testToolFailure() {
  log("\n=== 测试 2: 工具执行失败 ===");
  
  const stopHook: HookCallback = async (input) => {
    log(`[Stop Hook] session=${input.session_id.substring(0, 8)}, transcript=${input.transcript_path}`);
    return {};
  };

  try {
    for await (const message of query({
      prompt: "读取一个不存在的文件 /nonexistent/file.txt",
      options: {
        cwd: process.cwd(),
        allowedTools: ["Read"],
        hooks: {
          Stop: [{ hooks: [stopHook] }],
        },
      },
    })) {
      if ("result" in message) {
        log(`结果: ${message.result.substring(0, 200)}`);
      }
    }
  } catch (error) {
    log(`捕获错误: ${error}`);
  }
}

// 测试 3: 超时场景（模拟）
async function testTimeout() {
  log("\n=== 测试 3: 超时中断模拟 ===");
  
  const stopHook: HookCallback = async (input) => {
    log(`[Stop Hook] 触发，transcript=${input.transcript_path}`);
    return {};
  };

  const controller = new AbortController();
  
  // 5 秒后中断
  setTimeout(() => {
    log("触发超时中断...");
    controller.abort();
  }, 5000);

  try {
    for await (const message of query({
      prompt: "执行一个耗时的任务：计算前 1000 个质数",
      options: {
        cwd: process.cwd(),
        allowedTools: ["Bash"],
        hooks: {
          Stop: [{ hooks: [stopHook] }],
        },
      },
    })) {
      if ("result" in message) {
        log(`结果: ${message.result.substring(0, 100)}`);
      }
    }
  } catch (error: any) {
    log(`超时错误: ${error.name} - ${error.message}`);
  }
}

async function main() {
  log("开始边缘场景测试...");
  
  await testPermissionRequest();
  await testToolFailure();
  await testTimeout();
  
  log("\n测试完成！");
}

main();

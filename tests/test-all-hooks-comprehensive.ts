import { query, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = "./test-output";

if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true });
}

const createHook = (name: string): HookCallback => async (input) => {
  const log = `[${name}] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, `${name.toLowerCase()}.log`), log);
  console.log(`✅ ${name} hook triggered`);
  return {};
};

async function testAllHooks() {
  console.log("测试所有 Hook 的触发条件...\n");

  try {
    // 测试 1: 纯文本回复（不使用工具）
    console.log("=== 测试 1: 纯文本回复（不使用工具） ===");
    for await (const message of query({
      prompt: "请用一句话介绍你自己，不要使用任何工具",
      options: {
        cwd: process.cwd(),
        allowedTools: [],  // 禁用所有工具
        hooks: {
          UserPromptSubmit: [{ hooks: [createHook("UserPromptSubmit")] }],
          SessionStart: [{ hooks: [createHook("SessionStart")] }],
          Stop: [{ hooks: [createHook("Stop")] }],
          Notification: [{ hooks: [createHook("Notification")] }],
        },
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        console.log(`会话 ID: ${message.session_id}`);
      }
      if ("result" in message) {
        console.log(`结果: ${message.result}\n`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    // 测试 2: 使用工具
    console.log("\n=== 测试 2: 使用工具 ===");
    for await (const message of query({
      prompt: "读取 package.json 文件",
      options: {
        cwd: process.cwd(),
        allowedTools: ["Read"],
        hooks: {
          PostToolUse: [{ hooks: [createHook("PostToolUse")] }],
          Stop: [{ hooks: [createHook("Stop")] }],
        },
      },
    })) {
      if ("result" in message) {
        console.log(`结果: ${message.result.substring(0, 100)}...\n`);
      }
    }

    console.log("\n检查日志文件:");
    console.log("- test-output/userpromptsubmit.log");
    console.log("- test-output/sessionstart.log");
    console.log("- test-output/stop.log");
    console.log("- test-output/notification.log");
    console.log("- test-output/posttooluse.log");
  } catch (error) {
    console.error("测试失败:", error);
  }
}

testAllHooks();

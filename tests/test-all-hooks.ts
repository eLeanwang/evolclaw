import { query, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = "./test-output";

if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true });
}

const preCompactHook: HookCallback = async (input) => {
  const log = `[PreCompact] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, "pre-compact.log"), log);
  console.log("\n✅ PreCompact hook triggered!");
  return {};
};

const sessionEndHook: HookCallback = async (input) => {
  const log = `[SessionEnd] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, "session-end.log"), log);
  console.log("\n✅ SessionEnd hook triggered!");
  return {};
};

const postToolUseHook: HookCallback = async (input) => {
  console.log("✓ PostToolUse");
  return {};
};

async function testAllHooks() {
  console.log("测试所有 Hook...\n");

  try {
    // 创建一个长会话，尝试触发 PreCompact
    const longPrompt = `
请执行以下任务：
1. 读取 package.json 文件
2. 读取 DESIGN.md 文件的前 50 行
3. 读取 VALIDATION-REPORT.md 文件的前 50 行
4. 读取 test-sdk-hooks.ts 文件
5. 总结所有文件的内容
`.trim();

    for await (const message of query({
      prompt: longPrompt,
      options: {
        cwd: process.cwd(),
        allowedTools: ["Read", "Grep"],
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [preCompactHook] }],
          SessionEnd: [{ hooks: [sessionEndHook] }],
        },
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        console.log(`会话 ID: ${message.session_id}`);
      }

      if ("result" in message) {
        console.log(`\n结果: ${message.result.substring(0, 150)}...`);
      }
    }

    console.log("\n会话结束，等待 Hook 触发...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log("\n检查日志文件:");
    console.log(`- ${join(TEST_DIR, "pre-compact.log")}`);
    console.log(`- ${join(TEST_DIR, "session-end.log")}`);
  } catch (error) {
    console.error("测试失败:", error);
  }
}

testAllHooks();

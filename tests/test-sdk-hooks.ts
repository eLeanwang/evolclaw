import { query, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = "./test-output";

// 确保测试目录存在
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true });
}

// 测试 1: PostToolUse Hook
const postToolUseHook: HookCallback = async (input) => {
  const log = `[PostToolUse] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, "post-tool-use.log"), log);
  console.log("✓ PostToolUse hook triggered");
  return {};
};

// 测试 2: PreCompact Hook
const preCompactHook: HookCallback = async (input) => {
  const log = `[PreCompact] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, "pre-compact.log"), log);
  console.log("✓ PreCompact hook triggered");
  return {};
};

// 测试 3: SessionEnd Hook
const sessionEndHook: HookCallback = async (input) => {
  const log = `[SessionEnd] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, "session-end.log"), log);
  console.log("✓ SessionEnd hook triggered");
  return {};
};

async function testHooks() {
  console.log("开始测试 Claude Agent SDK Hook 机制...\n");

  let sessionId: string | undefined;

  try {
    for await (const message of query({
      prompt: "读取当前目录下的 package.json 文件，告诉我项目名称",
      options: {
        cwd: process.cwd(),
        allowedTools: ["Read"],
        hooks: {
          PostToolUse: [{ matcher: ".*", hooks: [postToolUseHook] }],
          PreCompact: [{ matcher: ".*", hooks: [preCompactHook] }],
          SessionEnd: [{ matcher: ".*", hooks: [sessionEndHook] }],
        },
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        console.log(`\n会话 ID: ${sessionId}`);
      }

      if ("result" in message) {
        console.log(`\n结果: ${message.result}`);
      }
    }

    console.log("\n测试完成！检查以下文件：");
    console.log(`- ${join(TEST_DIR, "post-tool-use.log")}`);
    console.log(`- ${join(TEST_DIR, "pre-compact.log")}`);
    console.log(`- ${join(TEST_DIR, "session-end.log")}`);

    if (sessionId) {
      console.log(`\n会话数据应该保存在: ~/.claude/projects/${process.cwd()}/sessions/${sessionId}/`);
    }
  } catch (error) {
    console.error("测试失败:", error);
  }
}

testHooks();

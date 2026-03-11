import { query, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = "./test-output";

if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR, { recursive: true });
}

const sessionEndHook: HookCallback = async (input) => {
  const log = `[SessionEnd] ${new Date().toISOString()}\n${JSON.stringify(input, null, 2)}\n\n`;
  appendFileSync(join(TEST_DIR, "session-end.log"), log);
  console.log("✅ SessionEnd hook triggered!");
  console.log("Context:", JSON.stringify(input, null, 2));
  return {};
};

async function testSessionEnd() {
  console.log("测试 SessionEnd Hook - 显式结束会话...\n");

  try {
    let sessionId: string | undefined;

    for await (const message of query({
      prompt: "读取 package.json 并告诉我项目名称",
      options: {
        cwd: process.cwd(),
        allowedTools: ["Read"],
        hooks: {
          SessionEnd: [{ matcher: ".*", hooks: [sessionEndHook] }],
        },
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        console.log(`会话 ID: ${sessionId}`);
      }

      if ("result" in message) {
        console.log(`结果: ${message.result}`);
      }
    }

    console.log("\n会话已结束，等待 SessionEnd Hook...");
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log("\n测试完成！检查 test-output/session-end.log");
  } catch (error) {
    console.error("测试失败:", error);
  }
}

testSessionEnd();

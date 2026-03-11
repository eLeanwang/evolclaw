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
  console.log("✅ PreCompact hook triggered!");
  console.log("Context:", JSON.stringify(input, null, 2));
  return {};
};

async function testPreCompact() {
  console.log("测试 PreCompact Hook - 创建长会话触发上下文压缩...\n");

  try {
    // 创建一个长会话，多次读取文件来填充上下文
    const prompts = [
      "读取 package.json 文件",
      "读取 DESIGN.md 文件的前 100 行",
      "读取 VALIDATION-REPORT.md 文件",
      "读取 test-sdk-hooks.ts 文件",
      "总结一下你读取的所有文件的内容",
    ];

    for (const prompt of prompts) {
      console.log(`\n发送提示: ${prompt}`);

      for await (const message of query({
        prompt,
        options: {
          cwd: process.cwd(),
          allowedTools: ["Read", "Grep"],
          hooks: {
            PreCompact: [{ matcher: ".*", hooks: [preCompactHook] }],
          },
        },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          console.log(`会话 ID: ${message.session_id}`);
        }

        if ("result" in message) {
          console.log(`结果: ${message.result.substring(0, 100)}...`);
        }
      }
    }

    console.log("\n测试完成！检查 test-output/pre-compact.log");
  } catch (error) {
    console.error("测试失败:", error);
  }
}

testPreCompact();

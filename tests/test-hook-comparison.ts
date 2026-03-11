import { query, HookCallback } from "@anthropic-ai/claude-agent-sdk";

let stopCount = 0;
let postToolUseCount = 0;

const stopHook: HookCallback = async (input) => {
  stopCount++;
  console.log(`✅ Stop Hook #${stopCount} - session: ${input.session_id.substring(0, 8)}`);
  return {};
};

const postToolUseHook: HookCallback = async (input) => {
  postToolUseCount++;
  console.log(`✅ PostToolUse Hook #${postToolUseCount} - tool: ${(input as any).tool_name}`);
  return {};
};

async function compareHooks() {
  console.log("=== 对比测试：Stop vs PostToolUse ===\n");

  // 场景 1: 纯文本回复
  console.log("场景 1: 纯文本回复（无工具）");
  stopCount = 0;
  postToolUseCount = 0;

  for await (const msg of query({
    prompt: "说一句话：Hello World",
    options: {
      allowedTools: [],
      hooks: {
        Stop: [{ hooks: [stopHook] }],
        PostToolUse: [{ hooks: [postToolUseHook] }],
      },
    },
  })) {
    if ("result" in msg) console.log(`结果: ${msg.result.substring(0, 50)}...`);
  }

  console.log(`Stop 触发次数: ${stopCount}, PostToolUse 触发次数: ${postToolUseCount}\n`);

  // 场景 2: 使用工具
  console.log("场景 2: 使用工具");
  stopCount = 0;
  postToolUseCount = 0;

  for await (const msg of query({
    prompt: "读取 package.json",
    options: {
      cwd: process.cwd(),
      allowedTools: ["Read"],
      hooks: {
        Stop: [{ hooks: [stopHook] }],
        PostToolUse: [{ hooks: [postToolUseHook] }],
      },
    },
  })) {
    if ("result" in msg) console.log(`结果: ${msg.result.substring(0, 50)}...`);
  }

  console.log(`Stop 触发次数: ${stopCount}, PostToolUse 触发次数: ${postToolUseCount}\n`);

  // 场景 3: 多次工具使用
  console.log("场景 3: 多次工具使用");
  stopCount = 0;
  postToolUseCount = 0;

  for await (const msg of query({
    prompt: "读取 package.json 和 tsconfig.json",
    options: {
      cwd: process.cwd(),
      allowedTools: ["Read"],
      hooks: {
        Stop: [{ hooks: [stopHook] }],
        PostToolUse: [{ hooks: [postToolUseHook] }],
      },
    },
  })) {
    if ("result" in msg) console.log(`结果: ${msg.result.substring(0, 50)}...`);
  }

  console.log(`Stop 触发次数: ${stopCount}, PostToolUse 触发次数: ${postToolUseCount}\n`);

  console.log("=== 结论 ===");
  console.log("Stop Hook: 在所有场景中都触发 1 次（响应完成后）");
  console.log("PostToolUse Hook: 只在使用工具时触发（每个工具 1 次）");
}

compareHooks();

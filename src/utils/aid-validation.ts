import fs from 'fs';
import path from 'path';
import { isValidAid } from '../aun/aid/identity.js';

/**
 * `agents/<dirName>` 是否能被当作合法的 self-agent 目录：
 *   - 目录名通过 isValidAid（标准多级域名）
 *   - 目录下存在 config.json
 *
 * 不满足返回原因字符串，调用方决定是 warn-and-skip 还是 throw。
 */
export function checkAgentDir(agentsDir: string, dirName: string): string | null {
  if (!isValidAid(dirName)) {
    return `dir name "${dirName}" is not a valid AID`;
  }
  const configPath = path.join(agentsDir, dirName, 'config.json');
  if (!fs.existsSync(configPath)) {
    return `missing ${path.join(dirName, 'config.json')}`;
  }
  return null;
}

export { isValidAid };

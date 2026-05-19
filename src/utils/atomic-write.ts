/**
 * Atomic write via dual rename.
 *
 * 写入流程（写 foo.json）：
 *   1. 把当前 foo.json 改名为 foo.json_   （保留旧版作为热备）
 *   2. 把新内容写到 foo.json__            （写入完成才有完整内容）
 *   3. 把 foo.json__ rename 为 foo.json   （原子切换）
 *   foo.json_ 留到下次写入时被覆盖。
 *
 * 读取时按以下顺序探测，自动恢复中途崩溃的状态：
 *   - foo.json__ 存在 → 上次写入未完成，丢弃
 *   - foo.json    存在 → 直接读
 *   - foo.json_   存在 → rename 步骤崩溃，rename 回 foo.json 再读
 *   - 都不存在 → null
 */

import fs from 'fs';
import path from 'path';

const HOT = '_';   // foo.json_   旧版热备
const TMP = '__';  // foo.json__  写入中

/**
 * 原子写入 JSON 文件（双 rename）。dirname 不存在时会自动创建。
 *
 * @param filePath 目标文件
 * @param content 完整内容（不含末尾换行也可，由调用方控制）
 */
export function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const hot = filePath + HOT;
  const tmp = filePath + TMP;

  // 步骤 1：当前文件 → hot（保留旧版作热备）
  if (fs.existsSync(filePath)) {
    if (fs.existsSync(hot)) fs.unlinkSync(hot);
    fs.renameSync(filePath, hot);
  }

  // 步骤 2：写到 tmp
  fs.writeFileSync(tmp, content, 'utf-8');

  // 步骤 3：tmp → 目标（原子）
  fs.renameSync(tmp, filePath);
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWrite(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * 原子读取——自动按状态恢复。文件不存在时返回 null。
 *
 * 调用方拿到 null 应当作"文件不存在"处理；解析失败抛错。
 */
export function atomicRead(filePath: string): string | null {
  const hot = filePath + HOT;
  const tmp = filePath + TMP;

  // 中途崩溃残留 → 丢弃
  if (fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  // rename 步骤崩溃 → 把 hot 移回正式名
  if (fs.existsSync(hot)) {
    fs.renameSync(hot, filePath);
    return fs.readFileSync(filePath, 'utf-8');
  }

  return null;
}

export function atomicReadJson<T = unknown>(filePath: string): T | null {
  const text = atomicRead(filePath);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

import path from 'path';

/** 去掉轮转后缀（"evolclaw-20260518-21.log" → "evolclaw"；"ts-sdk-2026-05-27.log" → "ts-sdk"）。入参可为文件名或绝对路径。 */
export function shortLogName(file: string): string {
  return path.basename(file, '.log')
    .replace(/-\d{8}-\d{2}$/, '')      // -YYYYMMDD-HH（按小时轮转）
    .replace(/-\d{4}-\d{2}-\d{2}$/, ''); // -YYYY-MM-DD（按日轮转，如 ts-sdk）
}

/** 从 .log 文件名列表推导去重、字母序的类型列表。 */
export function deriveLogTypes(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.log')) continue;
    set.add(shortLogName(f));
  }
  return [...set].sort();
}

/** 计算预勾集合：saved 为 undefined → 全勾；否则只勾命中 saved 的类型（新类型不勾）。 */
export function computePreChecked(types: string[], saved: string[] | undefined): Set<string> {
  if (saved === undefined) return new Set(types);
  const savedSet = new Set(saved);
  return new Set(types.filter(t => savedSet.has(t)));
}

/** 返回 requested 中不在 available 里的无效类型。 */
export function validateLogTypes(requested: string[], available: string[]): string[] {
  const set = new Set(available);
  return requested.filter(t => !set.has(t));
}

/** 只保留类型命中 filterTypes 的文件路径。 */
export function filterLogFiles(files: string[], filterTypes: Set<string>): string[] {
  return files.filter(f => filterTypes.has(shortLogName(f)));
}

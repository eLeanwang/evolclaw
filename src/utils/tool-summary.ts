/**
 * 工具调用摘要与 Edit diff 预览渲染
 *
 * 提取工具调用的可读描述，供权限审批和消息展示使用。
 * Edit 工具的摘要为 diff 风格预览（支持 old/new_string 与 unified diff 两种输入）。
 */

import fs from 'fs';

/**
 * 工具输入摘要（提取工具调用的可读描述，供权限审批和消息展示使用）
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';

  const extractors: Record<string, (i: any) => string | undefined> = {
    'Read':  (i) => i.file_path,
    'Edit':  (i) => formatEditSummary(i),
    'Write': (i) => i.file_path,
    'Bash':  (i) => {
      const cmd = i.command?.substring(0, 80) || '';
      const desc = i.description;
      if (desc && cmd) return `${cmd} | ${desc}`;
      return cmd || desc;
    },
    'Grep':  (i) => `pattern: ${i.pattern}`,
    'Glob':  (i) => `pattern: ${i.pattern}`,
    'Agent': (i) => i.description || i.prompt?.substring(0, 80),
    'Skill': (i) => i.skill ? `${i.skill}${i.args ? ' ' + i.args : ''}` : undefined,
    'ExitPlanMode': (i) => {
      if (i.allowedPrompts?.length) {
        return `计划包含 ${i.allowedPrompts.length} 项操作权限`;
      }
      return '计划审批';
    },
    'TodoWrite': (i) => {
      if (Array.isArray(i.todos)) {
        return i.todos.map((t: any) => t.content || t.task || t.text).filter(Boolean).join(', ').substring(0, 80);
      }
      return undefined;
    },
    'TaskCreate': (i) => i.subject || i.description?.substring(0, 80),
    'TaskUpdate': (i) => i.status ? `${i.taskId} → ${i.status}` : i.taskId,
    'TaskOutput': (i) => `${i.task_id || '?'}${i.block === false ? ' (non-blocking)' : ''}${i.timeout ? ` timeout=${i.timeout}ms` : ''}`,
    'TaskStop': (i) => i.task_id || i.shell_id || '?',
    'NotebookEdit': (i) => i.notebook_path,
    'WebFetch': (i) => i.url,
    'WebSearch': (i) => i.query?.substring(0, 80),
  };

  const extractor = extractors[toolName];
  if (extractor) {
    const result = extractor(input);
    if (result) return result;
  }

  return (input as any).description
    || (input as any).subject
    || (input as any).file_path
    || (input as any).pattern
    || (input as any).command?.substring(0, 80)
    || (input as any).prompt?.substring(0, 80)
    || (input as any).query?.substring(0, 80)
    || (input as any).skill
    || (input as any).url
    || '';
}

const EDIT_PREVIEW_MAX_LINES = 14;
const EDIT_PREVIEW_CONTEXT_LINES = 2;
const EDIT_PREVIEW_INLINE_GAP_LINES = 4;

type EditPreviewMarker = '−' | '＋' | ' ';
interface EditPreviewLine {
  marker: EditPreviewMarker;
  text: string;
  lineNo?: number;
  changed?: boolean;
  raw?: string;
}

/** 为 Edit 工具生成 diff 风格摘要 */
function formatEditSummary(input: any): string {
  const filePath = input.file_path || '';
  const protocolDiff = typeof input.unified_diff === 'string' ? input.unified_diff
    : typeof input.unifiedDiff === 'string' ? input.unifiedDiff
    : typeof input.diff === 'string' ? input.diff
    : '';
  if (protocolDiff) return formatProtocolDiffSummary(filePath, protocolDiff);

  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';

  if (!oldStr && !newStr) return filePath;

  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // 尝试从文件中定位 old_string 的起始行号
  let startLine = 0; // 0-based; 0 means unknown
  if (filePath && oldStr) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx >= 0) {
        startLine = content.slice(0, idx).split('\n').length; // 1-based
      }
    } catch {
      // 文件不可读，行号留空
    }
  }

  // 找公共前缀行数
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }
  // 找公共后缀行数
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const diffLines: EditPreviewLine[] = [];
  const makeLine = (idx: number, marker: EditPreviewMarker, text: string, changed = marker !== ' ') => ({
    lineNo: startLine > 0 ? startLine + idx : undefined,
    marker,
    text,
    changed,
  });

  // 上下文前缀（最多 EDIT_PREVIEW_CONTEXT_LINES 行）
  const ctxStart = Math.max(0, prefixLen - EDIT_PREVIEW_CONTEXT_LINES);
  for (let i = ctxStart; i < prefixLen; i++) {
    diffLines.push(makeLine(i, ' ', oldLines[i], false));
  }

  // 删除行
  const removedEnd = oldLines.length - suffixLen;
  for (let i = prefixLen; i < removedEnd; i++) {
    diffLines.push(makeLine(i, '−', oldLines[i]));
  }

  // 新增行（行号从 prefixLen 位置开始递增）
  const addedEnd = newLines.length - suffixLen;
  for (let i = prefixLen; i < addedEnd; i++) {
    diffLines.push(makeLine(i, '＋', newLines[i]));
  }

  // 上下文后缀（最多 EDIT_PREVIEW_CONTEXT_LINES 行）
  const ctxEnd = Math.min(oldLines.length, removedEnd + EDIT_PREVIEW_CONTEXT_LINES);
  for (let i = removedEnd; i < ctxEnd; i++) {
    diffLines.push(makeLine(i, ' ', oldLines[i], false));
  }

  return renderEditPreview(filePath, diffLines);
}

/** 展示 runner/协议已返回的 unified diff；按 Claude Edit 预览策略投影为行号摘要。 */
function formatProtocolDiffSummary(filePath: string, diff: string): string {
  const parsed = parseUnifiedDiffPreview(diff);
  if (parsed.length > 0) {
    return renderEditPreview(filePath, selectEditPreviewRows(parsed));
  }

  const fallback = diff.trimEnd().split('\n')
    .filter(line => !isDiffMetadataLine(line))
    .map(line => {
      const marker: EditPreviewMarker = line.startsWith('-') ? '−' : line.startsWith('+') ? '＋' : ' ';
      const text = line.startsWith('-') || line.startsWith('+') ? line.slice(1) : line;
      return { marker, text, changed: marker !== ' ' };
    });
  return renderEditPreview(filePath, selectEditPreviewRows(fallback));
}

function renderEditPreview(filePath: string, lines: EditPreviewLine[]): string {
  if (lines.length === 0) return filePath;
  const maxLineNo = lines.reduce((max, line) => Math.max(max, line.lineNo ?? 0), 0);
  const padWidth = maxLineNo > 0 ? maxLineNo.toString().length : 0;
  const body = lines.map(line => {
    if (line.raw) return line.raw;
    if (line.lineNo != null && line.lineNo > 0) {
      return `${line.lineNo.toString().padStart(padWidth)} ${line.marker}  ${line.text}`;
    }
    return `${line.marker}  ${line.text}`;
  }).join('\n');
  return `${filePath}\n\`\`\`\n${body}\n\`\`\``;
}

function parseUnifiedDiffPreview(diff: string): EditPreviewLine[] {
  const preview: EditPreviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.trimEnd().split('\n')) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\ No newline')) continue;

    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === ' ') {
      preview.push({ lineNo: oldLine, marker: ' ', text, changed: false });
      oldLine++;
      newLine++;
    } else if (prefix === '-') {
      preview.push({ lineNo: oldLine, marker: '−', text, changed: true });
      oldLine++;
    } else if (prefix === '+') {
      preview.push({ lineNo: newLine, marker: '＋', text, changed: true });
      newLine++;
    }
  }

  return preview;
}

function selectEditPreviewRows(lines: EditPreviewLine[]): EditPreviewLine[] {
  const changeIdxs = lines
    .map((line, idx) => line.changed ? idx : -1)
    .filter(idx => idx >= 0);
  if (changeIdxs.length === 0) {
    return lines.slice(0, EDIT_PREVIEW_MAX_LINES + EDIT_PREVIEW_CONTEXT_LINES);
  }

  const changed = new Set(changeIdxs);
  const keep = new Set<number>(changeIdxs);
  const contextCandidates = new Map<number, number>();
  let groupStart = changeIdxs[0];
  let prev = changeIdxs[0];
  const addGroup = (start: number, end: number) => {
    for (let distance = 1; distance <= EDIT_PREVIEW_CONTEXT_LINES; distance++) {
      const before = start - distance;
      const after = end + distance;
      if (before >= 0 && !changed.has(before)) {
        contextCandidates.set(before, Math.min(contextCandidates.get(before) ?? distance, distance));
      }
      if (after < lines.length && !changed.has(after)) {
        contextCandidates.set(after, Math.min(contextCandidates.get(after) ?? distance, distance));
      }
    }
  };

  for (let i = 1; i < changeIdxs.length; i++) {
    const idx = changeIdxs[i];
    if (idx === prev + 1) {
      prev = idx;
      continue;
    }
    addGroup(groupStart, prev);
    groupStart = idx;
    prev = idx;
  }
  addGroup(groupStart, prev);

  const contextBudget = Math.max(0, EDIT_PREVIEW_MAX_LINES + EDIT_PREVIEW_CONTEXT_LINES - keep.size);
  const orderedCandidates = [...contextCandidates.entries()]
    .sort(([idxA, distA], [idxB, distB]) => distA - distB || idxA - idxB);
  for (const [idx] of orderedCandidates.slice(0, contextBudget)) {
    keep.add(idx);
  }

  const ordered = [...keep].sort((a, b) => a - b);
  const selected: EditPreviewLine[] = [];
  let previousIdx: number | undefined;
  for (const idx of ordered) {
    if (previousIdx !== undefined) {
      const gap = idx - previousIdx - 1;
      if (gap > EDIT_PREVIEW_INLINE_GAP_LINES) {
        selected.push({ marker: ' ', text: '...', raw: '  ...' });
      } else {
        for (let i = previousIdx + 1; i < idx; i++) {
          selected.push(lines[i]);
        }
      }
    }
    selected.push(lines[idx]);
    previousIdx = idx;
  }
  const lastIdx = ordered[ordered.length - 1];
  const tailGap = lines.length - 1 - lastIdx;
  if (tailGap > EDIT_PREVIEW_INLINE_GAP_LINES) {
    selected.push({ marker: ' ', text: '...', raw: '  ...' });
  } else {
    for (let i = lastIdx + 1; i < lines.length; i++) {
      selected.push(lines[i]);
    }
  }
  return selected;
}

function isDiffMetadataLine(line: string): boolean {
  return /^diff --git /.test(line)
    || /^index /.test(line)
    || /^new file mode /.test(line)
    || /^deleted file mode /.test(line)
    || /^similarity index /.test(line)
    || /^rename (?:from|to) /.test(line)
    || /^--- /.test(line)
    || /^\+\+\+ /.test(line);
}

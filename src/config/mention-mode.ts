/**
 * mentionMode ↔ AUN 协议 dispatch_mode 词汇翻译（单一事实源）。
 *
 * 配置层用 mentionMode（disabled / mention-only），AUN 协议层用 dispatch_mode
 * （broadcast / mention）。二者语义等价，仅词汇不同：
 *   - mention-only（只处理被 @ 的消息）≡ mention（仅被 @ 时响应）
 *   - disabled（关闭 mention 过滤）    ≡ broadcast（全部响应）
 *
 * 仅在协议边界（AUN resolver、render fallback）翻译；配置层、命令层一律用
 * mentionMode 词汇。
 */

export type MentionMode = 'disabled' | 'mention-only';

/** config → AUN 协议词汇；未知/未设值返回 undefined（回退服务端 dispatch_mode）。 */
export function mentionModeToDispatch(mode?: string): 'mention' | 'broadcast' | undefined {
  if (mode === 'mention-only') return 'mention';
  if (mode === 'disabled') return 'broadcast';
  return undefined;
}

/** AUN 协议词汇 → config；未知返回 undefined。 */
export function dispatchToMentionMode(dispatch?: string): MentionMode | undefined {
  if (dispatch === 'mention') return 'mention-only';
  if (dispatch === 'broadcast') return 'disabled';
  return undefined;
}

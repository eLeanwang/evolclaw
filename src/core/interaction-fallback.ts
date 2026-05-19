import type { CommandCard, InteractionRequest } from '../types.js';

/** 把 CommandCard 渲染为文本提示，channel 不支持卡片时使用 */
export function renderCommandCardAsText(card: CommandCard): string {
  const lines: string[] = [card.title];
  if (card.body) lines.push(card.body);
  lines.push('', '可用命令:');
  for (const btn of card.buttons) {
    const marker = btn.disabled ? '✓' : ' ';
    lines.push(`  ${marker} ${btn.command}    ← ${btn.label}`);
  }
  return lines.join('\n');
}

/** 把 ActionInteraction 渲染为文本提示，channel 不支持卡片或卡片发送失败时使用 */
export function renderActionAsText(req: InteractionRequest): string {
  if (req.kind.kind !== 'action') {
    throw new Error('[renderActionAsText] expected ActionInteraction, got ' + req.kind.kind);
  }
  const action = req.kind;
  const fb = req.fallback;
  const lines: string[] = [action.title];
  if (action.body) lines.push(action.body);

  if (!fb) {
    return lines.join('\n');
  }

  lines.push('', '回复:');
  for (const btn of action.buttons) {
    const arg = fb.buttonArgMap?.[btn.key] ?? btn.key;
    lines.push(`  /${fb.command} ${arg}    ← ${btn.label}`);
  }
  if (fb.acceptFreeText && fb.freeTextHint) {
    lines.push(`  ${fb.freeTextHint}`);
  }
  return lines.join('\n');
}

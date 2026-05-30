import { describe, it, expect } from 'vitest';
import {
  buildInteractionCard,
  buildActionCard,
  buildActionCardV2,
  buildCustomInputElements,
  needsCardKitV2,
} from '../../src/channels/feishu.js';
import type {
  InteractionRequest,
  ActionInteraction,
} from '../../src/types.js';

describe('Feishu Card Builders', () => {
  describe('buildInteractionCard', () => {
    it('should dispatch action kind to buildActionCard', () => {
      const interaction: InteractionRequest = {
        type: 'interaction',
        id: 'req-1',
        channelId: 'chat-1',
        sessionId: 'sess-1',
        kind: {
          kind: 'action',
          title: 'Confirm',
          buttons: [{ key: 'ok', label: 'OK' }],
        },
      };

      const card = buildInteractionCard(interaction) as any;
      expect(card).not.toBeNull();
      expect(card.header.title.content).toBe('Confirm');
    });

    it('should return null for unknown kind', () => {
      const interaction = {
        type: 'interaction',
        id: 'req-3',
        channelId: 'chat-1',
        sessionId: 'sess-1',
        kind: {
          kind: 'unknown',
        },
      } as any;

      expect(buildInteractionCard(interaction)).toBeNull();
    });
  });

  describe('buildActionCard', () => {
    it('should build card with header and buttons', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: '🔄 确认重启',
        buttons: [
          { key: 'confirm', label: '确认', style: 'danger' },
          { key: 'cancel', label: '取消', style: 'default' },
        ],
      };

      const card = buildActionCard('req-1', action) as any;

      expect(card.header.template).toBe('blue');
      expect(card.header.title.content).toBe('🔄 确认重启');
      expect(card.config.wide_screen_mode).toBe(true);

      // Should have action element with buttons
      const actionEl = card.elements.find((e: any) => e.tag === 'action');
      expect(actionEl).toBeDefined();
      expect(actionEl.actions).toHaveLength(2);

      // Danger button
      expect(actionEl.actions[0].type).toBe('danger');
      expect(actionEl.actions[0].text.content).toBe('确认');
      expect(actionEl.actions[0].value._request_id).toBe('req-1');
      expect(actionEl.actions[0].value._action).toBe('confirm');
      expect(actionEl.actions[0].value._btn_label).toBe('确认');

      // Default button
      expect(actionEl.actions[1].type).toBe('default');
      expect(actionEl.actions[1].text.content).toBe('取消');
      expect(actionEl.actions[1].value._action).toBe('cancel');
      expect(actionEl.actions[1].value._btn_label).toBe('取消');
    });

    it('should include body text as markdown element', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        body: '**Warning**: this is dangerous',
        buttons: [{ key: 'ok', label: 'OK' }],
      };

      const card = buildActionCard('req-2', action) as any;
      const markdownEl = card.elements.find((e: any) => e.tag === 'markdown');
      expect(markdownEl).toBeDefined();
      expect(markdownEl.content).toContain('**Warning**: this is dangerous');
    });

    it('should include button labels in _card_body even without body text', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        buttons: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Beta' },
        ],
      };

      const card = buildActionCard('req-3', action) as any;
      const btn = card.elements.find((e: any) => e.tag === 'action').actions[0];
      expect(btn.value._card_body).toBe('Alpha  ·  Beta');
    });

    it('should include body + button labels in _card_body', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        body: 'Some info',
        buttons: [{ key: 'ok', label: 'OK' }],
      };

      const card = buildActionCard('req-4', action) as any;
      const btn = card.elements.find((e: any) => e.tag === 'action').actions[0];
      expect(btn.value._card_body).toBe('Some info\n\nOK');
    });

    it('should include confirm dialog when button has confirm', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        buttons: [{
          key: 'delete',
          label: 'Delete',
          style: 'danger',
          confirm: { title: 'Are you sure?', body: 'This cannot be undone.' },
        }],
      };

      const card = buildActionCard('req-5', action) as any;
      const btn = card.elements.find((e: any) => e.tag === 'action').actions[0];
      expect(btn.confirm).toBeDefined();
      expect(btn.confirm.title.content).toBe('Are you sure?');
      expect(btn.confirm.text.content).toBe('This cannot be undone.');
    });

    it('should embed _card_title in button values', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'My Card Title',
        buttons: [{ key: 'a', label: 'A' }],
      };

      const card = buildActionCard('req-6', action) as any;
      const btn = card.elements.find((e: any) => e.tag === 'action').actions[0];
      expect(btn.value._card_title).toBe('My Card Title');
    });

    it('should map primary style correctly', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        buttons: [{ key: 'a', label: 'A', style: 'primary' }],
      };

      const card = buildActionCard('req-7', action) as any;
      const btn = card.elements.find((e: any) => e.tag === 'action').actions[0];
      expect(btn.type).toBe('primary');
    });
  });

  describe('needsCardKitV2', () => {
    it('should return true when checkers are present', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        buttons: [{ key: 'ok', label: 'OK' }],
        checkers: [{ key: 'opt1', label: 'Option 1' }],
      };
      expect(needsCardKitV2(action)).toBe(true);
    });

    it('should return true when allowCustomInput is set', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        buttons: [{ key: 'ok', label: 'OK' }],
        allowCustomInput: true,
      };
      expect(needsCardKitV2(action)).toBe(true);
    });

    it('should return false for plain action without checkers or allowCustomInput', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Test',
        buttons: [{ key: 'ok', label: 'OK' }],
      };
      expect(needsCardKitV2(action)).toBe(false);
    });
  });

  describe('buildInteractionCard V2 routing', () => {
    it('should return null for action that needs CardKit V2 (checkers)', () => {
      const interaction: InteractionRequest = {
        type: 'interaction',
        id: 'req-v2-1',
        channelId: 'chat-1',
        sessionId: 'sess-1',
        kind: {
          kind: 'action',
          title: 'Select options',
          buttons: [{ key: 'submit', label: 'Submit' }],
          checkers: [{ key: 'a', label: 'Alpha' }],
        },
      };
      // V2 cards go through CardKit entity path, buildInteractionCard returns null
      expect(buildInteractionCard(interaction)).toBeNull();
    });

    it('should return null for action with allowCustomInput', () => {
      const interaction: InteractionRequest = {
        type: 'interaction',
        id: 'req-v2-2',
        channelId: 'chat-1',
        sessionId: 'sess-1',
        kind: {
          kind: 'action',
          title: 'Approve plan',
          buttons: [{ key: 'approve', label: 'Approve' }],
          allowCustomInput: true,
        },
      };
      expect(buildInteractionCard(interaction)).toBeNull();
    });
  });

  describe('buildActionCardV2 — AskUserQuestion (multi-select checkers)', () => {
    it('should produce schema 2.0 with form wrapper', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Which features do you want?',
        buttons: [{ key: 'submit', label: 'Submit' }],
        checkers: [
          { key: 'dark_mode', label: 'Dark mode', description: 'Toggle dark theme' },
          { key: 'i18n', label: 'Internationalization' },
        ],
      };

      const card = buildActionCardV2('req-ask-1', action) as any;

      expect(card.schema).toBe('2.0');
      expect(card.header.title.content).toBe('Which features do you want?');
      expect(card.header.template).toBe('blue');
      expect(card.body.elements).toHaveLength(1);
      expect(card.body.elements[0].tag).toBe('form');
      expect(card.body.elements[0].element_id).toBe('action_form');
    });

    it('should render checkers with label and description', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Select',
        buttons: [{ key: 'ok', label: 'OK' }],
        checkers: [
          { key: 'a', label: 'Alpha', description: 'First letter' },
          { key: 'b', label: 'Beta' },
        ],
      };

      const card = buildActionCardV2('req-ask-2', action) as any;
      const formEls = card.body.elements[0].elements;

      // First checker: label + description
      const chk0 = formEls.find((e: any) => e.element_id === 'chk_0');
      expect(chk0.tag).toBe('checker');
      expect(chk0.name).toBe('opt_0');
      expect(chk0.checked).toBe(false);
      expect(chk0.text.content).toBe('Alpha — First letter');

      // Second checker: label only
      const chk1 = formEls.find((e: any) => e.element_id === 'chk_1');
      expect(chk1.tag).toBe('checker');
      expect(chk1.text.content).toBe('Beta');
    });

    it('should include hr separator after checkers', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Pick',
        buttons: [{ key: 'go', label: 'Go' }],
        checkers: [{ key: 'x', label: 'X' }],
      };

      const card = buildActionCardV2('req-ask-3', action) as any;
      const formEls = card.body.elements[0].elements;
      const hr = formEls.find((e: any) => e.element_id === 'hr_btns');
      expect(hr).toBeDefined();
      expect(hr.tag).toBe('hr');
    });

    it('should render buttons with form_submit action_type', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Choose',
        buttons: [
          { key: 'yes', label: 'Yes', style: 'primary' },
          { key: 'no', label: 'No', style: 'danger' },
        ],
        checkers: [{ key: 'opt', label: 'Option' }],
      };

      const card = buildActionCardV2('req-ask-4', action, 'user-123') as any;
      const formEls = card.body.elements[0].elements;

      const btnYes = formEls.find((e: any) => e.element_id === 'btn_0');
      expect(btnYes.tag).toBe('button');
      expect(btnYes.text.content).toBe('Yes');
      expect(btnYes.type).toBe('primary');
      expect(btnYes.action_type).toBe('form_submit');
      expect(btnYes.name).toBe('btn_0');
      expect(btnYes.value._request_id).toBe('req-ask-4');
      expect(btnYes.value._action).toBe('yes');
      expect(btnYes.value._initiator).toBe('user-123');
      expect(btnYes.value._card_title).toBe('Choose');
      expect(btnYes.value._btn_label).toBe('Yes');

      const btnNo = formEls.find((e: any) => e.element_id === 'btn_1');
      expect(btnNo.type).toBe('danger');
      expect(btnNo.text.content).toBe('No');
      expect(btnNo.value._action).toBe('no');
    });

    it('should include body markdown before checkers', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Question',
        body: '**Please select** your preferences:',
        buttons: [{ key: 'done', label: 'Done' }],
        checkers: [{ key: 'a', label: 'A' }],
      };

      const card = buildActionCardV2('req-ask-5', action) as any;
      const formEls = card.body.elements[0].elements;

      const mdEl = formEls.find((e: any) => e.element_id === 'body_md');
      expect(mdEl.tag).toBe('markdown');
      expect(mdEl.content).toBe('**Please select** your preferences:');

      // body_md should come before checkers
      const mdIdx = formEls.indexOf(mdEl);
      const chkIdx = formEls.findIndex((e: any) => e.element_id === 'chk_0');
      expect(mdIdx).toBeLessThan(chkIdx);
    });

    it('should compose _card_body from body + button labels', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Q',
        body: 'Context info',
        buttons: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Beta' },
        ],
        checkers: [{ key: 'x', label: 'X' }],
      };

      const card = buildActionCardV2('req-ask-6', action) as any;
      const formEls = card.body.elements[0].elements;
      const btn = formEls.find((e: any) => e.element_id === 'btn_0');
      expect(btn.value._card_body).toBe('Context info\n\nAlpha  ·  Beta');
    });
  });

  describe('buildActionCardV2 — PlanMode (allowCustomInput)', () => {
    it('should add manual input button when allowCustomInput is true', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Approve implementation plan?',
        body: '## Plan\n1. Add auth middleware\n2. Write tests',
        buttons: [
          { key: 'approve', label: 'Approve', style: 'primary' },
          { key: 'reject', label: 'Reject', style: 'danger' },
        ],
        allowCustomInput: true,
      };

      const card = buildActionCardV2('req-plan-1', action, 'owner-aid') as any;
      // 「手动输入」按钮放在 form 容器外（body.elements[1]），不在 form 内
      const inputBtn = card.body.elements.find((e: any) => e.element_id === 'btn_show_input');
      expect(inputBtn).toBeDefined();
      expect(inputBtn.tag).toBe('button');
      expect(inputBtn.text.content).toBe('✏️ 手动输入');
      expect(inputBtn.type).toBe('default');
      expect(inputBtn.value._request_id).toBe('req-plan-1');
      expect(inputBtn.value._action).toBe('_show_input');
      expect(inputBtn.value._initiator).toBe('owner-aid');
      expect(inputBtn.value._btn_label).toBe('手动输入');
    });

    it('should not add manual input button when allowCustomInput is false/absent', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Simple action',
        buttons: [{ key: 'ok', label: 'OK' }],
        checkers: [{ key: 'x', label: 'X' }],
      };

      const card = buildActionCardV2('req-plan-2', action) as any;
      const formEls = card.body.elements[0].elements;
      const inputBtn = formEls.find((e: any) => e.element_id === 'btn_show_input');
      expect(inputBtn).toBeUndefined();
    });

    it('should render plan body as markdown in form', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Plan approval',
        body: '## Steps\n- Step 1\n- Step 2\n- Step 3',
        buttons: [{ key: 'approve', label: 'Approve' }],
        allowCustomInput: true,
      };

      const card = buildActionCardV2('req-plan-3', action) as any;
      const formEls = card.body.elements[0].elements;
      const mdEl = formEls.find((e: any) => e.element_id === 'body_md');
      expect(mdEl.tag).toBe('markdown');
      expect(mdEl.content).toContain('## Steps');
      expect(mdEl.content).toContain('- Step 1');
    });

    it('should have no checkers when only allowCustomInput is set', () => {
      const action: ActionInteraction = {
        kind: 'action',
        title: 'Feedback',
        buttons: [{ key: 'ok', label: 'OK' }],
        allowCustomInput: true,
      };

      const card = buildActionCardV2('req-plan-4', action) as any;
      const formEls = card.body.elements[0].elements;
      const checkers = formEls.filter((e: any) => e.tag === 'checker');
      expect(checkers).toHaveLength(0);
      // No hr separator either (only added after checkers)
      const hr = formEls.find((e: any) => e.element_id === 'hr_btns');
      expect(hr).toBeUndefined();
    });
  });

  describe('buildCustomInputElements', () => {
    it('should return hr + input + submit button', () => {
      const elements = buildCustomInputElements('req-ci-1', 'user-abc') as any[];

      expect(elements).toHaveLength(3);

      // hr separator
      expect(elements[0].tag).toBe('hr');
      expect(elements[0].element_id).toBe('hr_input');

      // input field
      expect(elements[1].tag).toBe('input');
      expect(elements[1].name).toBe('custom_text');
      expect(elements[1].element_id).toBe('input_custom');
      expect(elements[1].placeholder.content).toBe('输入自定义回复...');

      // submit button
      expect(elements[2].tag).toBe('button');
      expect(elements[2].text.content).toBe('✅ 提交输入');
      expect(elements[2].type).toBe('primary');
      expect(elements[2].action_type).toBe('form_submit');
      expect(elements[2].name).toBe('btn_submit_custom');
      expect(elements[2].value._request_id).toBe('req-ci-1');
      expect(elements[2].value._action).toBe('_custom_input');
      expect(elements[2].value._initiator).toBe('user-abc');
    });

    it('should work without initiatorId', () => {
      const elements = buildCustomInputElements('req-ci-2') as any[];
      expect(elements[2].value._initiator).toBeUndefined();
      expect(elements[2].value._request_id).toBe('req-ci-2');
    });
  });
});

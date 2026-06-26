import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/eck/manifest-engine.js';
import fs from 'fs';
import path from 'path';

describe('Proactive Mode Template Rendering', () => {
  const sessionTemplatePath = path.join(process.cwd(), 'kits/templates/system-fragments/session.md');
  const sessionTemplate = fs.readFileSync(sessionTemplatePath, 'utf-8');

  describe('chatMode=proactive with chatType=group', () => {
    it('should render group send command', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'group',
        selfAid: 'alice.agentid.pub',
        groupId: 'group123',
        peerId: 'bob.agentid.pub',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).toContain('proactive 模式');
      expect(rendered).toContain('ec group send alice.agentid.pub group123');
      expect(rendered).not.toContain('ec msg send');
      expect(rendered).toContain('第一时间发消息说明意图');
    });

    it('should include mention option for group', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'group',
        selfAid: 'alice.agentid.pub',
        groupId: 'group123',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).toContain('--mention <aid>');
    });
  });

  describe('chatMode=proactive with chatType=private', () => {
    it('should render msg send command', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).toContain('proactive 模式');
      expect(rendered).toContain('ec msg send alice.agentid.pub bob.agentid.pub');
      expect(rendered).not.toContain('ec group send');
      expect(rendered).not.toContain('--mention');
    });
  });

  describe('chatMode=interactive', () => {
    it('should not render proactive mode instructions', () => {
      const vars = {
        chatMode: 'interactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).not.toContain('proactive 模式');
      expect(rendered).not.toContain('ec msg send');
      expect(rendered).not.toContain('ec group send');
    });
  });

  describe('edge cases', () => {
    it('should handle missing chatMode (defaults to no proactive block)', () => {
      const vars = {
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).not.toContain('proactive 模式');
    });

    it('should handle proactive without chatType', () => {
      const vars = {
        chatMode: 'proactive',
        selfAid: 'alice.agentid.pub',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      // Should render proactive block but no command format
      expect(rendered).toContain('proactive 模式');
      expect(rendered).not.toContain('ec group send');
      expect(rendered).not.toContain('ec msg send');
    });

    it('should handle both group and private vars (group takes precedence in rendering)', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'group',
        selfAid: 'alice.agentid.pub',
        groupId: 'group123',
        peerId: 'bob.agentid.pub', // sender in group chat
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      // Should only show group command
      expect(rendered).toContain('ec group send');
      expect(rendered).not.toContain('ec msg send');
    });
  });

  describe('10-tool-call reminder', () => {
    it('should include the 10-tool-call reminder in all proactive modes', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).toContain('超过 10 次工具调用需再次汇报情况');
    });
  });

  describe('proactive behavior switches', () => {
    it('should keep proactive instructions enabled when switches are omitted', () => {
      const rendered = renderTemplate(sessionTemplate, {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
      });

      expect(rendered).toContain('第一时间发消息说明意图');
      expect(rendered).toContain('超过 10 次工具调用需再次汇报情况');
    });

    it('should hide first-send and tool-count instructions when switches are off', () => {
      const rendered = renderTemplate(sessionTemplate, {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
        proactivePreTool1stMsgChk: false,
        proactiveToolUseReminder: false,
      });

      expect(rendered).not.toContain('第一时间发消息说明意图');
      expect(rendered).not.toContain('不要闷头干');
      expect(rendered).not.toContain('超过 10 次工具调用需再次汇报情况');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/eck/manifest-engine.js';
import fs from 'fs';
import path from 'path';

describe('Proactive Mode Template Rendering', () => {
  const sessionTemplatePath = path.join(process.cwd(), 'kits/templates/system-fragments/session.md');
  const sessionTemplate = fs.readFileSync(sessionTemplatePath, 'utf-8');
  const channelTemplatePath = path.join(process.cwd(), 'kits/templates/system-fragments/channel.md');
  const channelTemplate = fs.readFileSync(channelTemplatePath, 'utf-8');

  describe('chatMode=proactive with chatType=group', () => {
    it('should render group send command', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'group',
        selfAid: 'alice.agentid.pub',
        groupId: 'group123',
        peerId: 'bob.agentid.pub',
        proactiveFirstSendRequired: true,
        proactiveToolReportRequired: true,
        proactiveToolReportInterval: 10,
        proactiveSendTargetLabel: '群里',
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).toContain('proactive 模式');
      expect(rendered).toContain('ec group send alice.agentid.pub group123');
      expect(rendered).not.toContain('ec msg send');
      expect(rendered).toContain('首次调用任何非发送工具前');
      expect(rendered).toContain('向群里说明意图');
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
        proactiveFirstSendRequired: true,
        proactiveSendTargetLabel: '对方',
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
    it('should include the tool-call report reminder when enabled by vars', () => {
      const vars = {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
        proactiveToolReportRequired: true,
        proactiveToolReportInterval: 10,
      };

      const rendered = renderTemplate(sessionTemplate, vars);

      expect(rendered).toContain('每 10 次非发送工具调用后');
    });
  });

  describe('proactive behavior switches', () => {
    it('should render proactive policy instructions from computed vars', () => {
      const rendered = renderTemplate(sessionTemplate, {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
        proactiveFirstSendRequired: true,
        proactiveToolReportRequired: true,
        proactiveToolReportInterval: 10,
        proactiveSendTargetLabel: '对方',
      });

      expect(rendered).toContain('首次调用任何非发送工具前');
      expect(rendered).toContain('每 10 次非发送工具调用后');
    });

    it('should hide first-send and tool-count instructions when computed vars are false', () => {
      const rendered = renderTemplate(sessionTemplate, {
        chatMode: 'proactive',
        chatType: 'private',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
        proactiveFirstSendRequired: false,
        proactiveToolReportRequired: false,
      });

      expect(rendered).not.toContain('首次调用任何非发送工具前');
      expect(rendered).not.toContain('非发送工具调用后');
    });
  });

  describe('channel file marker instructions', () => {
    it('injects file marker syntax for interactive non-AUN channels with file support', () => {
      const rendered = renderTemplate(channelTemplate, {
        channel: 'feishu',
        chatMode: 'interactive',
        peerId: 'ou_user',
        capabilities: '图片输入、图片输出、文件发送',
        supportsFileMarker: true,
      });

      expect(rendered).toContain('发送文件语法：');
      expect(rendered).toContain('[SEND_FILE:文件路径]');
      expect(rendered).toContain('相对路径从项目根目录解析');
      expect(rendered).toContain('非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI');
      expect(rendered).not.toContain('FILE_MARKER');
    });

    it('does not inject marker syntax for AUN channel file support', () => {
      const rendered = renderTemplate(channelTemplate, {
        channel: 'aun',
        chatMode: 'interactive',
        selfAid: 'alice.agentid.pub',
        peerId: 'bob.agentid.pub',
        capabilities: '图片输出、文件发送',
        supportsFileMarker: false,
      });

      expect(rendered).not.toContain('发送文件语法：');
      expect(rendered).toContain('ec msg send alice.agentid.pub bob.agentid.pub');
    });

    it('does not inject marker syntax when marker processing is unavailable', () => {
      const rendered = renderTemplate(channelTemplate, {
        channel: 'feishu',
        chatMode: 'proactive',
        peerId: 'ou_user',
        capabilities: '图片输入、图片输出',
        supportsFileMarker: false,
      });

      expect(rendered).not.toContain('发送文件语法：');
      expect(rendered).not.toContain('[SEND_FILE:文件路径]');
    });

    it('keeps the active file marker parser on the public SEND_FILE syntax only', () => {
      const responseEngine = fs.readFileSync(path.join(process.cwd(), 'src/core/message/response-engine.ts'), 'utf-8');

      expect(responseEngine).toContain('[SEND_FILE:path]');
      expect(responseEngine).not.toContain('FILE_MARKER');
      expect(responseEngine).toContain('channelPlaceholders');
      expect(responseEngine).toContain("'channel'");
      expect(responseEngine).toContain("'\\u6e20\\u9053'");
    });
  });
});

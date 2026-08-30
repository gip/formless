import { describe, expect, it, vi } from 'vitest';
import { createCanvasTools } from '../lib/webmcp-tools';
import { UserMessageQueue } from '../lib/message-queue';

describe('WebMCP tool contracts', () => {
  it('lists all required tools and validates highlight IDs', async () => {
    const sendPreviewCommand = vi.fn();
    const project = {
      listFiles: vi.fn(async () => ({ revision: 0, files: [] })),
      readFiles: vi.fn(),
      applyChanges: vi.fn(),
      reset: vi.fn(),
    };
    const tools = createCanvasTools({
      project: project as never,
      messages: new UserMessageQueue(),
      getElements: () => [{ id: 'send', label: 'Send', description: '', role: 'button', visible: true, enabled: true, kind: 'button' }],
      sendPreviewCommand,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_project_files', 'read_project_files', 'apply_project_changes', 'reset_project',
      'get_ui_elements', 'highlight_ui_elements', 'clear_ui_highlights', 'poll_user_messages',
    ]);
    const highlight = tools.find((tool) => tool.name === 'highlight_ui_elements')!;
    expect(await highlight.execute({ elementIds: ['missing'], color: '#D9FF63', restTreatment: 'dim' })).toMatchObject({ ok: false });
    expect(await highlight.execute({
      elementIds: ['send'],
      color: '#d9ff63',
      alternateColor: '#ff5a6f',
      blinkIntervalMs: 400,
      durationSeconds: 10,
      restTreatment: 'hide',
    })).toMatchObject({
      ok: true,
      color: '#D9FF63',
      alternateColor: '#FF5A6F',
      blinkIntervalMs: 400,
      durationSeconds: 10,
    });
    expect(sendPreviewCommand).toHaveBeenCalledWith('highlight', expect.objectContaining({
      elementIds: ['send'],
      alternateColor: '#FF5A6F',
      blinkIntervalMs: 400,
      durationSeconds: 10,
    }));
    expect(await highlight.execute({ elementIds: ['send'], color: '#d9ff63', alternateColor: 'red', restTreatment: 'dim' })).toMatchObject({ ok: false });
    expect(await highlight.execute({ elementIds: ['send'], color: '#d9ff63', durationSeconds: 0, restTreatment: 'dim' })).toMatchObject({ ok: false });
  });
});

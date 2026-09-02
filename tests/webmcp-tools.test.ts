import { describe, expect, it, vi } from 'vitest';
import type { AppVersion } from '../lib/canvas-types';
import { createCanvasTools } from '../lib/webmcp-tools';
import { UserMessageQueue } from '../lib/message-queue';

const publishedVersion: AppVersion = {
  id: '00112233445566aa',
  name: 'Dark dashboard',
  description: '',
  contentHash: 'aaaabbbbccccdddd',
  authorLabel: 'builder-abc123',
  mine: true,
  starterHash: '1111222233334444',
  fileCount: 2,
  bytes: 512,
  createdAt: '2026-09-01T10:00:00.000Z',
};

function versionStub() {
  return {
    list: vi.fn(async () => [publishedVersion]),
    publish: vi.fn(async () => publishedVersion),
    switchTo: vi.fn(async () => ({ revision: 3, version: publishedVersion })),
    current: vi.fn(() => ({ id: null, name: 'Starter project', dirty: true })),
  };
}

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
      versions: versionStub(),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_website_summary',
      'get_website_prompt',
      'list_project_files', 'read_project_files', 'apply_project_changes', 'reset_project',
      'get_ui_elements', 'highlight_ui_elements', 'clear_ui_highlights', 'poll_user_messages',
      'list_app_versions', 'publish_app_version', 'switch_app_version',
    ]);
    const summary = tools.find((tool) => tool.name === 'get_website_summary')!;
    expect(summary.description).toContain('first');
    expect(await summary.execute({})).toMatchObject({
      ok: true,
      website: { name: 'WebAlly' },
      startupInstructions: expect.arrayContaining([
        expect.stringContaining('list_project_files'),
        expect.stringContaining('apply_project_changes'),
        expect.stringContaining('poll_user_messages'),
      ]),
    });
    const prompt = tools.find((tool) => tool.name === 'get_website_prompt')!;
    expect(prompt.annotations.readOnlyHint).toBe(true);
    expect(await prompt.execute({})).toEqual({
      ok: true,
      prompt: 'Follow the user\'s instructions. Keep the WebAlly browser visible to the user at all times.',
    });
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

  it('guards publishing and switching behind confirmation and the current revision', async () => {
    const versions = versionStub();
    const project = { listFiles: vi.fn(async () => ({ revision: 7, files: [] })) };
    const tools = createCanvasTools({
      project: project as never,
      messages: new UserMessageQueue(),
      getElements: () => [],
      sendPreviewCommand: vi.fn(),
      versions,
    });
    const list = tools.find((tool) => tool.name === 'list_app_versions')!;
    const publish = tools.find((tool) => tool.name === 'publish_app_version')!;
    const swap = tools.find((tool) => tool.name === 'switch_app_version')!;

    expect(list.annotations.readOnlyHint).toBe(true);
    expect(await list.execute({})).toEqual({
      ok: true,
      current: { id: null, name: 'Starter project', dirty: true },
      versions: [publishedVersion],
    });

    // Publishing is public and not undone by a rollback, so it needs both an
    // explicit confirmation and the revision the agent believes it is on.
    expect(await publish.execute({ baseRevision: 7, name: 'Dark dashboard' })).toMatchObject({ ok: false });
    expect(await publish.execute({ baseRevision: 6, name: 'Dark dashboard', confirm: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Revision conflict'),
    });
    expect(await publish.execute({ baseRevision: 7, name: '  ', confirm: true })).toMatchObject({ ok: false });
    expect(versions.publish).not.toHaveBeenCalled();
    expect(await publish.execute({ baseRevision: 7, name: 'Dark dashboard', confirm: true })).toEqual({
      ok: true,
      version: publishedVersion,
    });

    expect(await swap.execute({ baseRevision: 7, versionId: publishedVersion.id })).toMatchObject({ ok: false });
    expect(await swap.execute({ baseRevision: 7, versionId: 'not-a-version', confirm: true })).toMatchObject({ ok: false });
    expect(versions.switchTo).not.toHaveBeenCalled();
    expect(await swap.execute({ baseRevision: 7, versionId: publishedVersion.id, confirm: true })).toEqual({
      ok: true,
      revision: 3,
      version: publishedVersion,
    });
  });
});

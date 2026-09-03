import { describe, expect, it, vi } from 'vitest';
import type { AppVersion } from '../lib/canvas-types';
import { createCanvasTools, type HealthAccess } from '../lib/webmcp-tools';
import type { HealthSnapshot } from '../lib/host-capabilities';
import { UserMessageQueue } from '../lib/message-queue';
import type { HealthExportDocument } from '../lib/health/types';
import type { SpeechPort } from '../lib/speech';

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

function speechStub(overrides: Partial<SpeechPort> = {}): SpeechPort {
  return {
    speak: vi.fn(async ({ text, voice }) => ({
      spoken: text,
      voice: voice ?? null,
      durationMs: 1200,
      interrupted: false,
      stillSpeaking: false,
    })),
    stop: vi.fn(() => ({ cancelled: true })),
    arm: vi.fn(),
    voices: vi.fn(() => [{ name: 'Samantha', lang: 'en-US', default: true }]),
    getState: vi.fn(() => ({ supported: true, armed: true, speaking: false, blocked: false, lastError: null })),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function versionStub() {
  return {
    list: vi.fn(async () => [publishedVersion]),
    publish: vi.fn(async () => publishedVersion),
    switchTo: vi.fn(async () => ({ revision: 3, version: publishedVersion })),
    current: vi.fn(() => ({ id: null, name: 'Starter project', dirty: true })),
  };
}

const connectedStatus = {
  configured: true,
  configuredProviders: ['ucsf'],
  connected: true,
  provider: 'UCSF Health',
  record: 'unlocked' as const,
};

function tinyRecord(): HealthExportDocument {
  return {
    schemaVersion: 1,
    exportedAt: '2026-08-01T00:00:00.000Z',
    exportedBy: 'Formless Health',
    source: { provider: 'UCSF Health', fhirBase: 'https://example.test/fhir', patientId: 'p1' },
    purpose: 'Testing.',
    limitations: [],
    data: {
      Patient: { resourceType: 'Patient', id: 'p1', name: [{ text: 'Jane Roe' }], birthDate: '1980-04-02' },
      Condition: [
        { resourceType: 'Condition', id: 'c1', status: 'active', code: { text: 'Asthma' }, recordedDate: '2019-05-04' },
        { resourceType: 'Condition', id: 'c2', status: 'resolved', code: { text: 'Sprained ankle' }, recordedDate: '2023-02-11' },
      ],
    },
    errors: {},
    priorAuthorizations: [],
    attachments: [
      {
        key: 'b1',
        binaryId: 'b1',
        contentType: 'text/html',
        size: 42,
        title: 'Visit note',
        text: '<p>Patient reports&nbsp;improvement.</p>',
      },
    ],
  };
}

function healthStub(snapshot?: Partial<HealthSnapshot>, privileged = true): HealthAccess {
  return {
    snapshot: async () => ({
      status: connectedStatus,
      source: 'connected',
      record: tinyRecord(),
      ...snapshot,
    }) as HealthSnapshot,
    grant: () => ({ scope: 'starter', privileged }),
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
      getRoutes: () => [{ path: '/', title: 'Home', description: 'Landing page.' }, { path: '/explore', title: 'Explore', description: 'Record explorer.' }],
      sendPreviewCommand,
      speech: speechStub(),
      health: healthStub(),
      versions: versionStub(),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_website_summary',
      'get_website_prompt',
      'list_project_files', 'read_project_files', 'apply_project_changes', 'reset_project',
      'get_ui_elements', 'navigate_to_route', 'highlight_ui_elements', 'clear_ui_highlights', 'poll_user_messages',
      'speak_text', 'stop_speaking',
      'get_health_summary', 'list_health_records', 'read_health_records',
      'list_app_versions', 'publish_app_version', 'switch_app_version',
    ]);
    const summary = tools.find((tool) => tool.name === 'get_website_summary')!;
    expect(summary.description).toContain('first');
    expect(await summary.execute({})).toMatchObject({
      ok: true,
      website: { name: 'Formless Labs' },
      startupInstructions: expect.arrayContaining([
        expect.stringContaining('list_project_files'),
        expect.stringContaining('apply_project_changes'),
        expect.stringContaining('poll_user_messages'),
        expect.stringContaining('speak_text'),
        expect.stringContaining('AgentButton'),
        expect.stringMatching(/devtools, CDP, injected CSS/),
      ]),
    });
    const prompt = tools.find((tool) => tool.name === 'get_website_prompt')!;
    expect(prompt.annotations.readOnlyHint).toBe(true);
    const promptResult = await prompt.execute({}) as { ok: true; prompt: string };
    expect(promptResult.ok).toBe(true);
    expect(promptResult.prompt).toContain('Keep the Formless Labs browser visible to the user at all times.');
    // An agent that reads only this prompt must still learn that the page is
    // changed through the tool, not through devtools or CDP. Leaving that to
    // startupInstructions alone is what let a real session inject CSS instead.
    expect(promptResult.prompt).toContain('only through apply_project_changes');
    expect(promptResult.prompt).toMatch(/devtools or CDP/);
    expect(promptResult.prompt).toMatch(/lost on reload/);
    // Every capability the page offers is named in the prompt together with
    // the tool that delivers it, so an agent that reads nothing else still
    // knows it can listen, speak, highlight, read the record, and publish.
    for (const named of [
      'poll_user_messages',
      'speak_text',
      'stop_speaking',
      'get_ui_elements',
      'highlight_ui_elements',
      'clear_ui_highlights',
      'navigate_to_route',
      'list_project_files',
      'read_project_files',
      'reset_project',
      'get_health_summary',
      'list_health_records',
      'read_health_records',
      'list_app_versions',
      'publish_app_version',
      'switch_app_version',
    ]) {
      expect(promptResult.prompt).toContain(named);
    }
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
      getRoutes: () => [],
      sendPreviewCommand: vi.fn(),
      speech: speechStub(),
      health: healthStub(),
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

describe('navigate_to_route', () => {
  function toolsWithRoutes(routes: { path: string; title: string; description: string }[]) {
    const sendPreviewCommand = vi.fn();
    const tools = createCanvasTools({
      project: {} as never,
      messages: new UserMessageQueue(),
      getElements: () => [],
      getRoutes: () => routes,
      sendPreviewCommand,
      speech: speechStub(),
      health: healthStub(),
      versions: versionStub(),
    });
    return { navigate: tools.find((tool) => tool.name === 'navigate_to_route')!, sendPreviewCommand };
  }

  const routes = [
    { path: '/', title: 'Home', description: 'Landing page.' },
    { path: '/explore', title: 'Explore', description: 'Record explorer.' },
  ];

  it('lists the declared routes when called with no path', async () => {
    const { navigate, sendPreviewCommand } = toolsWithRoutes(routes);
    expect(await navigate.execute({})).toEqual({ ok: true, routes });
    expect(sendPreviewCommand).not.toHaveBeenCalled();
  });

  it('posts a navigate event for a declared route', async () => {
    const { navigate, sendPreviewCommand } = toolsWithRoutes(routes);
    expect(await navigate.execute({ path: '/explore' })).toEqual({ ok: true, route: routes[1] });
    expect(sendPreviewCommand).toHaveBeenCalledWith('host-event', {
      event: 'navigate',
      payload: { path: '/explore' },
    });
  });

  it('refuses a route the app never declared', async () => {
    const { navigate, sendPreviewCommand } = toolsWithRoutes(routes);
    expect(await navigate.execute({ path: '/admin' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown route'),
    });
    expect(sendPreviewCommand).not.toHaveBeenCalled();
  });

  it('explains itself when the app declared no routes at all', async () => {
    const { navigate } = toolsWithRoutes([]);
    expect(await navigate.execute({ path: '/explore' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('has not declared any routes'),
    });
  });
});

describe('speak_text and stop_speaking', () => {
  function speechTools(speech: SpeechPort) {
    return createCanvasTools({
      project: {} as never,
      messages: new UserMessageQueue(),
      getElements: () => [],
      getRoutes: () => [],
      sendPreviewCommand: vi.fn(),
      speech,
      health: healthStub(),
      versions: versionStub(),
    });
  }

  it('forwards every speech option and samples the available voices', async () => {
    const speech = speechStub();
    const tools = speechTools(speech);
    const speak = tools.find((tool) => tool.name === 'speak_text')!;

    // Speaking is an external side effect, so it is not a read-only tool.
    expect(speak.annotations.readOnlyHint).toBe(false);
    expect(await speak.execute({ text: 'Your record is ready.', voice: 'Daniel', rate: 1.2, interrupt: true })).toEqual({
      ok: true,
      spoken: 'Your record is ready.',
      voice: 'Daniel',
      durationMs: 1200,
      interrupted: false,
      stillSpeaking: false,
      voiceCount: 1,
      availableVoices: [{ name: 'Samantha', lang: 'en-US', default: true }],
    });
    expect(speech.speak).toHaveBeenCalledWith({
      text: 'Your record is ready.',
      voice: 'Daniel',
      lang: undefined,
      rate: 1.2,
      pitch: undefined,
      volume: undefined,
      interrupt: true,
    });
  });

  it('reports a port failure as a tool error rather than throwing', async () => {
    const speech = speechStub({
      speak: vi.fn(async () => { throw new Error('The browser refused to speak. Ask the user to click the page.'); }),
    });
    const speak = speechTools(speech).find((tool) => tool.name === 'speak_text')!;
    expect(await speak.execute({ text: 'hello' })).toEqual({
      ok: false,
      error: expect.stringContaining('refused to speak'),
    });
    expect(await speak.execute({ text: 42 })).toMatchObject({ ok: false, error: 'text must be a string.' });
  });

  it('stops whatever is being spoken', async () => {
    const speech = speechStub();
    const stop = speechTools(speech).find((tool) => tool.name === 'stop_speaking')!;
    expect(await stop.execute({})).toEqual({ ok: true, cancelled: true });
    expect(speech.stop).toHaveBeenCalled();
  });
});

describe('health record tools', () => {
  function healthTools(health: HealthAccess) {
    return createCanvasTools({
      project: {} as never,
      messages: new UserMessageQueue(),
      getElements: () => [],
      getRoutes: () => [],
      sendPreviewCommand: vi.fn(),
      speech: speechStub(),
      health,
      versions: versionStub(),
    });
  }

  function healthTool(name: string, health: HealthAccess) {
    return healthTools(health).find((tool) => tool.name === name)!;
  }

  it('marks every health tool read-only and its content untrusted', () => {
    const tools = healthTools(healthStub());
    for (const name of ['get_health_summary', 'list_health_records', 'read_health_records']) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.annotations.readOnlyHint).toBe(true);
      // Clinical prose is text this page did not author.
      expect(tool.annotations.untrustedContentHint).toBe(true);
    }
  });

  it('summarizes a connected record', async () => {
    const result = await healthTool('get_health_summary', healthStub()).execute({}) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, source: 'connected' });
    expect(result.notice).toBeUndefined();
    expect(result).toMatchObject({
      summary: { totals: { resources: 4 }, patient: { name: 'Jane Roe' } },
    });
  });

  it('says plainly when the record is the de-identified sample', async () => {
    const sample = healthStub({ source: 'sample' });
    for (const name of ['get_health_summary', 'list_health_records', 'read_health_records']) {
      const input = name === 'read_health_records' ? { group: 'Condition' } : {};
      const result = await healthTool(name, sample).execute(input) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, source: 'sample' });
      expect(String(result.notice)).toContain('not the user');
    }
  });

  it('refuses every health tool while a stranger\'s version is loaded', async () => {
    const stranger = healthStub(undefined, false);
    for (const name of ['get_health_summary', 'list_health_records', 'read_health_records']) {
      expect(await healthTool(name, stranger).execute({})).toMatchObject({
        ok: false,
        error: expect.stringContaining('published by someone else'),
      });
    }
  });

  it('distinguishes a locked record from one still downloading', async () => {
    const locked = healthStub({ source: 'none', reason: 'locked', record: undefined });
    const summary = await healthTool('get_health_summary', locked).execute({}) as Record<string, unknown>;
    // Not a failure: the connection state is what tells the user what to click.
    expect(summary).toMatchObject({ ok: true, source: 'none', reason: 'locked' });
    expect(String(summary.guidance)).toContain('unlock');
    expect(await healthTool('list_health_records', locked).execute({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('locked'),
    });

    const importing = healthStub({ source: 'none', reason: 'importing', record: undefined });
    expect(await healthTool('list_health_records', importing).execute({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('downloaded right now'),
    });
  });

  it('lists dated, titled lines and pages them', async () => {
    const list = healthTool('list_health_records', healthStub());
    const result = await list.execute({ group: 'Condition', limit: 1 }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, total: 2, returned: 1, nextOffset: 1 });
    const entries = result.entries as { ref: string; title: string; date?: string }[];
    // Newest first: the sprain is more recent than the asthma.
    expect(entries[0]).toMatchObject({ ref: 'Condition/c2', title: 'Sprained ankle', date: '2023-02-11' });
  });

  it('rejects a sort it does not implement', async () => {
    expect(await healthTool('list_health_records', healthStub()).execute({ sort: 'title' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('sort must be'),
    });
  });

  it('reads full content by ref, and by group when given no refs', async () => {
    const read = healthTool('read_health_records', healthStub());

    const fields = await read.execute({ refs: ['Condition/c1'] }) as Record<string, unknown>;
    expect(fields).toMatchObject({ ok: true, format: 'fields' });
    expect((fields.items as { fields: unknown[] }[])[0].fields.length).toBeGreaterThan(0);

    const fhir = await read.execute({ refs: ['Condition/c1'], format: 'fhir' }) as Record<string, unknown>;
    expect((fhir.items as { fhir: Record<string, unknown> }[])[0].fhir).toMatchObject({
      resourceType: 'Condition',
      id: 'c1',
    });

    const byGroup = await read.execute({ group: 'Conditions' }) as Record<string, unknown>;
    expect((byGroup.items as unknown[]).length).toBe(2);
  });

  it('reads captured note text as prose', async () => {
    const result = await healthTool('read_health_records', healthStub())
      .execute({ refs: ['Binary/b1'], format: 'text' }) as Record<string, unknown>;
    expect((result.items as { text: string }[])[0].text).toBe('Patient reports improvement.');
  });

  it('refuses more refs than it will read at once', async () => {
    const refs = Array.from({ length: 21 }, (_, index) => `Condition/c${index}`);
    expect(await healthTool('read_health_records', healthStub()).execute({ refs })).toMatchObject({
      ok: false,
      error: expect.stringContaining('at once'),
    });
  });

  it('asks for refs or a group rather than guessing', async () => {
    expect(await healthTool('read_health_records', healthStub()).execute({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('Pass refs'),
    });
  });
});

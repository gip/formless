import { expect, type Page, test } from '@playwright/test';

import { installModelContext } from './model-context';
import { acceptTerms } from './terms';

function callTool(page: Page, name: string, input: Record<string, unknown> = {}) {
  return page.evaluate(async ([toolName, args]) => {
    const tools = (window as unknown as { __tools: { name: string; execute: (i: unknown) => Promise<unknown> }[] }).__tools;
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Tool not registered: ${toolName}`);
    return tool.execute(args);
  }, [name, input] as const);
}

/**
 * Pushes a `host-event` into the preview exactly as `CanvasApp` does. The real
 * sender is an Epic import, which needs a client id and a human at a MyChart
 * sign-in; the guest half of the protocol is the part under test here.
 */
async function pushHostEvent(page: Page, event: string, payload?: unknown) {
  await page.evaluate(([name, data]) => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Editable WebMCP application preview"]',
    );
    if (!frame?.contentWindow) throw new Error('The preview frame is not mounted.');
    frame.contentWindow.postMessage(
      { protocol: 'webmcp-canvas/v1', type: 'host-event', payload: { event: name, payload: data } },
      new URL(frame.src).origin,
    );
  }, [event, payload] as const);
}

test('exposes the canvas and registers its tools natively', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Formless Labs' })).toBeVisible();

  const names = await page.evaluate(() =>
    (window as unknown as { __tools: { name: string }[] }).__tools.map((tool) => tool.name));
  expect(names).toEqual([
    'get_website_summary', 'get_website_prompt',
    'list_project_files', 'read_project_files', 'apply_project_changes', 'reset_project',
    'get_ui_elements', 'navigate_to_route', 'highlight_ui_elements', 'clear_ui_highlights', 'poll_user_messages',
    'speak_text', 'stop_speaking',
    'get_health_summary', 'list_health_records', 'read_health_records',
    'list_app_versions', 'publish_app_version', 'switch_app_version',
  ]);
});

test('registers each tool once and keeps it registered', async ({ page }) => {
  // This stub deliberately ignores the AbortSignal, so any re-registration
  // shows up as duplicates: the preview becoming ready must not tear the tools
  // down and rebuild them, or an agent listing them in that window sees nothing.
  await page.addInitScript(() => {
    const registered: unknown[] = [];
    (window as unknown as { __tools: unknown[] }).__tools = registered;
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool: (tool: unknown) => { registered.push(tool); } },
    });
  });
  await page.goto('/');

  const count = () => page.evaluate(() => (window as unknown as { __tools: unknown[] }).__tools.length);
  await expect.poll(count, { timeout: 10_000 }).toBe(19);

  await page.locator('.preview-stage[data-phase="ready"]').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1_500);
  expect(await count()).toBe(19);
});

test('queues a final mocked speech transcript from the editable preview', async ({ page }) => {
  await installModelContext(page);
  await page.addInitScript(() => {
    class MockSpeechRecognition {
      lang = '';
      interimResults = false;
      continuous = false;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      start() {
        window.setTimeout(() => {
          this.onresult?.({ results: { length: 1, 0: { isFinal: true, 0: { transcript: 'Make the main action coral' } } } });
          this.onend?.();
        }, 10);
      }

      stop() { this.onend?.(); }
    }

    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: MockSpeechRecognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: MockSpeechRecognition });
  });

  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await acceptTerms(preview);
  await expect(preview.getByRole('button', { name: 'Speak', exact: true })).toBeVisible({ timeout: 90_000 });
  await preview.getByRole('button', { name: 'Speak', exact: true }).click();
  await expect.poll(async () => {
    const result = await callTool(page, 'poll_user_messages', { afterId: 0 }) as { messages: { text: string }[] };
    return result.messages.map((message) => message.text);
  }, { timeout: 10_000 }).toContain('Make the main action coral');
});

test('dims the whole preview while a timed highlight blinks between two colors', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await acceptTerms(preview);
  await expect(preview.getByRole('button', { name: 'Send to agent' })).toBeVisible({ timeout: 90_000 });

  expect(await callTool(page, 'highlight_ui_elements', {
    elementIds: ['send-prompt'],
    color: '#D9FF63',
    alternateColor: '#FF5A6F',
    blinkIntervalMs: 100,
    durationSeconds: 0.8,
    restTreatment: 'dim',
    dimOpacity: 0.24,
  })).toMatchObject({ ok: true });

  const overlay = preview.locator('#agent-highlight-overlay');
  await expect(overlay).toBeVisible();
  await expect(preview.locator('[data-agent-backdrop]')).toHaveCSS('fill', 'rgb(255, 255, 255)');
  await expect(preview.locator('[data-agent-backdrop]')).toHaveCSS('opacity', '0.76');
  await expect(preview.locator('[data-agent-mask] rect')).toHaveCount(2);
  await expect.poll(() => overlay.evaluate((node) => getComputedStyle(node).getPropertyValue('--agent-active-color').trim()), {
    timeout: 700,
    intervals: [25],
  }).toBe('#FF5A6F');
  await expect(overlay).toHaveCount(0, { timeout: 2_000 });
});

test('reads the health record through its tools, sample and all', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await acceptTerms(preview);
  await expect(preview.getByRole('button', { name: 'Send to agent' })).toBeVisible({ timeout: 90_000 });

  // With no Epic client id configured the host serves the de-identified sample,
  // and every result has to say so — an agent presenting a stranger's history
  // as the user's own is the worst failure these tools have.
  // `setHealthAccess` lands in a mount effect, so the first call can arrive
  // before the port exists.
  await expect.poll(
    async () => (await callTool(page, 'get_health_summary') as { ok: boolean }).ok,
    { timeout: 15_000 },
  ).toBe(true);

  const summary = await callTool(page, 'get_health_summary') as Record<string, unknown>;
  expect(summary).toMatchObject({ ok: true, source: 'sample' });
  expect(String(summary.notice)).toContain('not the user');
  expect(summary.summary).toMatchObject({ totals: { resources: 1412 } });

  const list = await callTool(page, 'list_health_records', { group: 'Observation', limit: 3 }) as {
    total: number;
    entries: { ref: string; title: string; date?: string }[];
  };
  expect(list.total).toBe(486);
  expect(list.entries).toHaveLength(3);
  expect(list.entries[0].ref).toMatch(/^Observation\//);

  const read = await callTool(page, 'read_health_records', {
    refs: [list.entries[0].ref],
    format: 'fhir',
  }) as { items: { fhir: { resourceType: string } }[] };
  expect(read.items[0].fhir.resourceType).toBe('Observation');

  // Clinical-note prose, decoded from the note bodies the fixture carries.
  const note = await callTool(page, 'list_health_records', { group: 'Binary', limit: 1 }) as {
    entries: { ref: string; hasText: boolean }[];
  };
  expect(note.entries[0].hasText).toBe(true);
  const text = await callTool(page, 'read_health_records', {
    refs: [note.entries[0].ref],
    format: 'text',
    maxChars: 200,
  }) as { items: { text: string }[] };
  expect(text.items[0].text.length).toBeGreaterThan(0);
  expect(text.items[0].text).not.toContain('<br>');
});

test('declares its routes and lets the agent navigate to the record explorer', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await acceptTerms(preview);
  await expect(preview.getByRole('button', { name: 'Send to agent' })).toBeVisible({ timeout: 90_000 });

  // The guest declares its own routes; the host never guesses them.
  await expect.poll(async () => {
    const result = await callTool(page, 'navigate_to_route') as { routes?: { path: string }[] };
    return (result.routes ?? []).map((route) => route.path);
  }, { timeout: 10_000 }).toEqual(['/', '/explore', '/terms']);

  // Navigating by tool rather than by click is the point: a person driving this
  // by voice should not have to locate and hit a link.
  expect(await callTool(page, 'navigate_to_route', { path: '/explore' }))
    .toMatchObject({ ok: true, route: { path: '/explore' } });

  // The record itself comes from the host over the capability bridge.
  await expect(preview.getByRole('heading', { name: 'John Smith', level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText('Data available')).toBeVisible();

  // Instrumented explorer controls reach the agent as targets it can highlight.
  const elements = await callTool(page, 'get_ui_elements') as { elements: { id: string }[] };
  const ids = elements.elements.map((element) => element.id);
  expect(ids).toContain('view-raw-json');
  expect(ids.some((id) => id.startsWith('resource-group-'))).toBe(true);

  // Clinical-note prose reaches the guest too. These two buttons existed long
  // before anything populated `resource.text`, so until note bodies were
  // carried on the record they always reported the text as unavailable.
  await preview.getByRole('button', { name: /Clinical-note files/i }).first().click();
  await expect(preview.locator('.resource-kicker')).toHaveText(/CLINICAL-NOTE FILES/i);
  await preview.locator('.resource-panel-actions button', { hasText: 'View text' }).click();
  const noteText = await preview.locator('dialog[open]').innerText();
  expect(noteText.length).toBeGreaterThan(200);
  expect(noteText).not.toContain('<br>');

  expect(await callTool(page, 'navigate_to_route', { path: '/nowhere' }))
    .toMatchObject({ ok: false, error: expect.stringContaining('Unknown route') });
});

test('shows the record view filling up while the host imports', async ({ page }) => {
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  // No `installModelContext` here: this drives the host directly, so the guest
  // composer is in its no-agent state and has no send button. The nav is the
  // readiness signal that does not depend on whether a client is attached.
  await expect(preview.getByRole('link', { name: 'Explore your record' })).toBeVisible({ timeout: 90_000 });
  await acceptTerms(preview);
  // The app starts on the landing page, and nothing has moved it.
  await expect(preview.getByRole('heading', { name: 'Downloading your record' })).toHaveCount(0);

  // A download starting takes the user to the record view on its own: the
  // sign-in popup has just closed, and this is where the record will appear.
  // The host sends the display name alongside the id: the guest holds only the
  // curated organizations and cannot resolve one of Epic's ~477 directory
  // entries back to a name on its own.
  await pushHostEvent(page, 'import.started', { providerId: 'ucsf', providerName: 'UCSF Health' });
  await expect(preview.getByRole('heading', { name: 'Downloading your record' }))
    .toBeVisible({ timeout: 15_000 });
  await expect(preview.getByText('From UCSF Health')).toBeVisible();

  await pushHostEvent(page, 'import.progress', {
    completedSearches: 6,
    totalSearches: 27,
    resourceCount: 412,
    attachmentCount: 0,
    label: 'Observation',
  });
  await expect(preview.getByText('412')).toBeVisible();
  await expect(preview.getByText('6 of 27 searches complete · latest observations')).toBeVisible();

  // The panel holds until the record itself is on screen; dropping it on
  // `import.finished` alone would flash an empty explorer in between.
  await pushHostEvent(page, 'import.finished', { ok: true });
  await expect(preview.getByRole('heading', { name: 'Downloading your record' })).toBeVisible();

  await pushHostEvent(page, 'record.changed');
  await expect(preview.getByRole('heading', { name: 'John Smith', level: 1 }))
    .toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText('Data available')).toBeVisible();
});

test('speaks agent text through the page and stops on request', async ({ page }) => {
  await installModelContext(page);
  // Headless Chromium ships no voices and never fires `end`, so the
  // synthesizer is mocked the same way SpeechRecognition is above.
  await page.addInitScript(() => {
    const spoken: { text: string; voice: string | null; rate: number }[] = [];
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    let pending: { onend: (() => void) | null } | null = null;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speaking: false,
        getVoices: () => [{ name: 'Test Voice', lang: 'en-US', default: true }],
        speak: (utterance: { text: string; voice: { name: string } | null; rate: number; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null }) => {
          // The primer the header button speaks is not a real utterance.
          if (utterance.text.trim() === '') { utterance.onend?.(); return; }
          spoken.push({ text: utterance.text, voice: utterance.voice?.name ?? null, rate: utterance.rate });
          pending = utterance;
          // Short utterances finish on their own; a long one stays pending so
          // the stop_speaking case below is a race with nothing.
          if (utterance.text.length <= 40) {
            window.setTimeout(() => { if (pending === utterance) { pending = null; utterance.onend?.(); } }, 50);
          }
        },
        cancel: () => {
          const utterance = pending as unknown as { onerror?: (event: { error: string }) => void } | null;
          pending = null;
          utterance?.onerror?.({ error: 'canceled' });
        },
        resume: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class {
        voice: unknown = null;
        lang = '';
        rate = 1;
        pitch = 1;
        volume = 1;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        constructor(public text: string) {}
      },
    });
  });

  await page.goto('/');
  // There is no voice control any more: `CanvasApp` arms the synthesizer on the
  // first interaction with the host page, so clicking the header is what gives
  // the document the user activation Chrome wants.
  await page.locator('header.topbar').click({ position: { x: 5, y: 5 } });

  expect(await callTool(page, 'speak_text', { text: 'Your record is ready.', voice: 'Test Voice', rate: 1.1 }))
    .toMatchObject({
      ok: true,
      spoken: 'Your record is ready.',
      voice: 'Test Voice',
      interrupted: false,
      stillSpeaking: false,
      availableVoices: [{ name: 'Test Voice', lang: 'en-US', default: true }],
    });
  expect(await page.evaluate(() => (window as unknown as { __spoken: { text: string; voice: string | null; rate: number }[] }).__spoken))
    .toEqual([{ text: 'Your record is ready.', voice: 'Test Voice', rate: 1.1 }]);

  // A pending utterance cut off by stop_speaking is a success, not a failure.
  const pending = callTool(page, 'speak_text', { text: 'A much longer explanation the user does not want to sit through.' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: unknown[] }).__spoken.length)).toBe(2);
  expect(await callTool(page, 'stop_speaking')).toMatchObject({ ok: true, cancelled: true });
  expect(await pending).toMatchObject({ ok: true, interrupted: true });

  expect(await callTool(page, 'speak_text', { text: 'hello', voice: 'Nobody' }))
    .toMatchObject({ ok: false, error: expect.stringContaining('Unknown voice') });
});

test('holds every route behind the terms of service until they are accepted', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');

  // The four things the gate exists to say. Two of them are the reason it is a
  // modal and not a banner: an attached agent forwards health information to
  // OpenAI, and a healthcare professional must not use this site at all.
  await expect(preview.getByText('Personal use only')).toBeVisible({ timeout: 90_000 });
  await expect(preview.getByText('No health data reaches our server')).toBeVisible();
  await expect(preview.getByText('An AI agent sees what you show it')).toBeVisible();
  await expect(preview.getByText('Not medical advice')).toBeVisible();

  // Nothing behind the dialog is reachable — the point of gating rather than
  // disclosing. A covered link fails its actionability check rather than
  // navigating, so the short timeout here is the assertion.
  await expect(
    preview.getByRole('link', { name: 'Explore your record' }).click({ timeout: 2_000 }),
  ).rejects.toThrow();

  // The full text is readable without leaving the dialog: linking to a page the
  // modal itself blocks would be a dead end.
  await preview.getByRole('button', { name: 'Read the full terms' }).click();
  await expect(preview.getByRole('heading', { name: /The AI agent, and what OpenAI receives/ }))
    .toBeVisible();
  await expect(preview.getByRole('heading', { name: /Healthcare professionals must not use this site/ }))
    .toBeVisible();

  await acceptTerms(preview);

  // And the same text stays available afterwards as an ordinary route.
  await preview.getByRole('link', { name: 'Terms', exact: true }).first().click();
  await expect(preview.getByRole('heading', { name: 'The terms you agreed to.', level: 1 }))
    .toBeVisible();

  // Acceptance is host-side state, so it survives the container reboot a reload
  // forces on the guest.
  await page.goto('/');
  await expect(preview.getByRole('button', { name: 'Send to agent' })).toBeVisible({ timeout: 90_000 });
  await expect(preview.getByRole('button', { name: 'Agree and continue' })).toHaveCount(0);
});

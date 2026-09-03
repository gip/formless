import { expect, type Page, test } from '@playwright/test';

/**
 * Installs the minimal `document.modelContext` a WebMCP browser provides, so
 * tests drive the tools through the same native registration path the macOS
 * shell uses. Chromium exposes no WebMCP of its own.
 */
async function installModelContext(page: Page) {
  await page.addInitScript(() => {
    const registered: unknown[] = [];
    (window as unknown as { __tools: unknown[] }).__tools = registered;
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        // Registration is owned by an AbortSignal: honouring it is what keeps
        // stale descriptors (registered before the preview origin existed) out
        // of the list, exactly as a real WebMCP browser does.
        registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => {
          registered.push(tool);
          options?.signal?.addEventListener('abort', () => {
            const index = registered.indexOf(tool);
            if (index >= 0) registered.splice(index, 1);
          });
        },
      },
    });
  });
}

function callTool(page: Page, name: string, input: Record<string, unknown> = {}) {
  return page.evaluate(async ([toolName, args]) => {
    const tools = (window as unknown as { __tools: { name: string; execute: (i: unknown) => Promise<unknown> }[] }).__tools;
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Tool not registered: ${toolName}`);
    return tool.execute(args);
  }, [name, input] as const);
}

test('exposes the canvas and registers its tools natively', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agent-ready interface lab' })).toBeVisible();
  await expect(page.getByText('Native WebMCP connected')).toBeVisible();

  const names = await page.evaluate(() =>
    (window as unknown as { __tools: { name: string }[] }).__tools.map((tool) => tool.name));
  expect(names).toEqual([
    'get_website_summary', 'get_website_prompt',
    'list_project_files', 'read_project_files', 'apply_project_changes', 'reset_project',
    'get_ui_elements', 'navigate_to_route', 'highlight_ui_elements', 'clear_ui_highlights', 'poll_user_messages',
    'speak_text', 'stop_speaking',
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
  await expect.poll(count, { timeout: 10_000 }).toBe(16);
  await expect(page.getByText('Native WebMCP connected')).toBeVisible();

  await page.locator('.preview-status.ready').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1_500);
  expect(await count()).toBe(16);
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

test('declares its routes and lets the agent navigate to the record explorer', async ({ page }) => {
  await installModelContext(page);
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await expect(preview.getByRole('button', { name: 'Send to agent' })).toBeVisible({ timeout: 90_000 });

  // The guest declares its own routes; the host never guesses them.
  await expect.poll(async () => {
    const result = await callTool(page, 'navigate_to_route') as { routes?: { path: string }[] };
    return (result.routes ?? []).map((route) => route.path);
  }, { timeout: 10_000 }).toEqual(['/', '/explore']);

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

  expect(await callTool(page, 'navigate_to_route', { path: '/nowhere' }))
    .toMatchObject({ ok: false, error: expect.stringContaining('Unknown route') });
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
  // The control is what gives the document the user activation Chrome wants.
  await page.getByRole('button', { name: 'Enable voice' }).click();
  await expect(page.getByRole('button', { name: 'Voice on' })).toBeVisible();

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

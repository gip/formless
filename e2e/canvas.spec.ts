import { expect, test } from '@playwright/test';

test('shows the preview-first stakeholder canvas and local tool bridge', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agent-ready interface lab' })).toBeVisible();
  await expect(page.getByText(/Local test bridge only|Native WebMCP connected/)).toBeVisible();
  await page.getByText('Tool console').click();
  await expect(page.getByRole('button', { name: 'Run tool' })).toBeVisible();
});

test('queues a final mocked speech transcript from the editable preview', async ({ page }) => {
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
  await expect(page.getByText('Make the main action coral')).toBeVisible({ timeout: 10_000 });
});

test('dims the whole preview while a timed highlight blinks between two colors', async ({ page }) => {
  await page.goto('/');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await expect(preview.getByRole('button', { name: 'Send to agent' })).toBeVisible({ timeout: 90_000 });

  await page.getByText('Tool console').click();
  await page.getByLabel('Tool').selectOption('highlight_ui_elements');
  await page.getByLabel('JSON arguments').fill(JSON.stringify({
    elementIds: ['send-prompt'],
    color: '#D9FF63',
    alternateColor: '#FF5A6F',
    blinkIntervalMs: 100,
    durationSeconds: 0.8,
    restTreatment: 'dim',
    dimOpacity: 0.24,
  }));
  await page.getByRole('button', { name: 'Run tool' }).click();

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

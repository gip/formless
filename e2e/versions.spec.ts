import { expect, test } from '@playwright/test';

import { installModelContext } from './model-context';

const TOKEN = 'e2e0000000000000000000000000cafe';
const OVERLAY = { 'src/App.tsx': 'export default function App() { return null; }' };
const STARTER_HASH = '1111222233334444';

test('publishes, lists, and unpublishes a version over the API', async ({ request }) => {
  const created = await request.post('/api/versions', {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: { name: 'API round trip', starterHash: STARTER_HASH, files: OVERLAY },
  });
  expect(created.status()).toBe(201);
  const { version } = await created.json();
  expect(version.id).toMatch(/^[0-9a-f]{16}$/);

  const listed = await (await request.get('/api/versions', {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json();
  expect(listed.versions.map((entry: { id: string }) => entry.id)).toContain(version.id);

  const detail = await (await request.get(`/api/versions/${version.id}`)).json();
  expect(detail.version.files).toEqual(OVERLAY);
  // Anyone can read it; only the publisher's token can change it.
  expect(detail.version.mine).toBe(false);
  expect((await request.delete(`/api/versions/${version.id}`)).status()).toBe(401);

  const removed = await request.delete(`/api/versions/${version.id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(removed.status()).toBe(200);
  expect((await request.get(`/api/versions/${version.id}`)).status()).toBe(404);
});

test('publishes the live app from the header and switches back to it', async ({ page }) => {
  // The stage's phase attribute, not the splash heading, is the signal the
  // preview is live.
  const ready = page.locator('.preview-stage[data-phase="ready"]');
  await page.goto('/');
  await expect(ready).toBeVisible({ timeout: 90_000 });

  const trigger = page.getByRole('button', { name: /^Version/ });
  await expect(trigger).toContainText('Default app');

  const name = `E2E ${Date.now().toString(36)}`;
  await trigger.click();
  await page.getByRole('button', { name: '+ Publish current…' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();

  // Publishing checks the working copy out as that version and deep-links to it.
  await expect(trigger).toContainText(name, { timeout: 20_000 });
  await expect(page).toHaveURL(/[?&]version=[0-9a-f]{16}/);
  const publishedUrl = page.url();

  // Switching to the starter and back exercises `loadVersion` in both directions.
  await trigger.click();
  await page.getByRole('menuitem', { name: /Default app/ }).click();
  await expect(trigger).toContainText('Default app', { timeout: 30_000 });
  await expect(page).not.toHaveURL(/[?&]version=/);

  await trigger.click();
  await page.getByRole('menuitem', { name: new RegExp(name) }).click();
  await expect(trigger).toContainText(name, { timeout: 30_000 });
  await expect(ready).toBeVisible({ timeout: 30_000 });

  // The `?version=` deep link is how the macOS shell opens a specific version.
  await page.goto(publishedUrl);
  await expect(trigger).toContainText(name, { timeout: 90_000 });

  await trigger.click();
  await page.getByTitle('Unpublish this version').first().click();
  await expect(page.getByRole('menuitem', { name: new RegExp(name) })).toHaveCount(0, { timeout: 20_000 });
});

test('keeps talking to the preview across a switch that re-creates the frame', async ({ page, request }) => {
  // A WebMCP client is attached for the whole test, so the guest's composer
  // must render its input the entire time. It renders "No agent is connected."
  // instead whenever the host's `mcp.status` answer fails to arrive — which is
  // what a stale preview window looks like from inside the iframe.
  await installModelContext(page);

  const ready = page.locator('.preview-stage[data-phase="ready"]');
  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  const composer = preview.getByRole('button', { name: 'Send to agent' });

  await page.goto('/');
  await expect(ready).toBeVisible({ timeout: 90_000 });
  await expect(composer).toBeVisible({ timeout: 90_000 });

  const trigger = page.getByRole('button', { name: /^Version/ });
  const name = `E2E foreign ${Date.now().toString(36)}`;
  await trigger.click();
  await page.getByRole('button', { name: '+ Publish current…' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(trigger).toContainText(name, { timeout: 20_000 });
  await expect(page).toHaveURL(/[?&]version=[0-9a-f]{16}/);
  const versionId = new URL(page.url()).searchParams.get('version') ?? '';
  const authorToken = await page.evaluate(() => window.localStorage.getItem('webally-publisher-token'));

  // Becoming a different publisher is what makes that version someone else's.
  // The reload resumes on it, because the snapshot remembers which version the
  // working copy is a checkout of — so this is a reader looking at a shared
  // version, which is where a switch crosses the boundary that matters: a
  // version that is not yours loads without `microphone` in the frame's
  // `allow`, and `allow` is read at load, so the iframe is keyed on it. The
  // switch therefore replaces the element while the preview URL — the other
  // half of that key, and the only thing the host used to watch — is unchanged.
  await page.evaluate(() => window.localStorage.setItem(
    'webally-publisher-token',
    'e2e-second-publisher-token',
  ));
  await page.goto('/');
  await expect(trigger).toContainText(name, { timeout: 90_000 });

  // Resuming on a version this browser did not publish now opens the trust
  // prompt over the canvas. Dismissing it is the sandboxed path — the one this
  // test is about — and the header must stay reachable afterwards.
  const trustPrompt = page.getByRole('dialog', { name: /was published by someone else/ });
  await expect(trustPrompt).toBeVisible({ timeout: 30_000 });
  await trustPrompt.getByRole('button', { name: 'Keep it sandboxed' }).click();
  await expect(trustPrompt).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sandboxed' })).toBeVisible();

  await expect(ready).toBeVisible({ timeout: 90_000 });
  await expect(composer).toBeVisible({ timeout: 90_000 });

  await trigger.click();
  await page.getByRole('menuitem', { name: /Default app/ }).click();
  await expect(trigger).toContainText('Default app', { timeout: 30_000 });
  await expect(ready).toBeVisible({ timeout: 30_000 });

  // The guest renders nothing at all until it hears from the host, and gives it
  // 1.5s before concluding it is on its own, so wait on the composer itself —
  // an absent offline panel this early only means the guest is still waiting.
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(preview.getByText('No agent is connected.')).toHaveCount(0);

  // The same channel carries every `host-request` response. Without it the
  // explorer sits on its spinner until the guest's own 30s timeout.
  await preview.getByRole('link', { name: 'Explore your record' }).click();
  await expect(preview.getByText('Opening your record…')).toHaveCount(0, { timeout: 15_000 });

  await request.delete(`/api/versions/${versionId}`, {
    headers: { authorization: `Bearer ${authorToken}` },
  });
});

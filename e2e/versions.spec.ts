import { expect, test } from '@playwright/test';

import { installModelContext } from './model-context';
import { acceptTerms } from './terms';

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
  // A WebMCP bridge is present for the whole test, so the guest's composer
  // must render its input the entire time. It renders the unsupported-browser
  // panel instead whenever the host's `mcp.status` answer fails to arrive —
  // which is what a stale preview window looks like from inside the iframe.
  // (No tool is ever called here, so the composer sits in its idle state; the
  // input is present either way, which is what this test is about.)
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
  await expect(preview.getByText('This browser does not support WebMCP.')).toHaveCount(0);

  // The same channel carries every `host-request` response. Without it the
  // explorer sits on its spinner until the guest's own 30s timeout — and the
  // terms gate, which is answered here for the starter's own scope, is one of
  // the things riding that channel.
  await acceptTerms(preview);
  await preview.getByRole('link', { name: 'Explore your record' }).click();
  await expect(preview.getByText('Opening your record…')).toHaveCount(0, { timeout: 15_000 });

  await request.delete(`/api/versions/${versionId}`, {
    headers: { authorization: `Bearer ${authorToken}` },
  });
});

test('closes the version menu on Escape, an outside click, and a click into the preview', async ({ page }) => {
  const ready = page.locator('.preview-stage[data-phase="ready"]');
  await page.goto('/');
  await expect(ready).toBeVisible({ timeout: 90_000 });

  const trigger = page.getByRole('button', { name: /^Version/ });
  const menu = page.getByRole('menu');
  const starter = page.getByRole('menuitem', { name: /Default app/ });

  // Escape, from the menu itself.
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // And the caret lands back on the trigger rather than on <body>.
  await expect(trigger).toBeFocused();

  // Escape out of the publish form discards the panel without publishing.
  await trigger.click();
  await page.getByRole('button', { name: '+ Publish current…' }).click();
  await page.getByLabel('Name').fill('Never published');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await expect(starter).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveCount(0);
  await expect(trigger).toContainText('Default app');

  // An ordinary outside click, on the host chrome.
  await page.locator('header.topbar h1').click();
  await expect(menu).toHaveCount(0);

  // And the one that actually happens: a click into the preview. It is a
  // cross-origin iframe, so it fires nothing in this document — only the window
  // blur that `VersionSwitcher` watches for.
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.frameLocator('iframe[title="Editable WebMCP application preview"]')
    .getByRole('heading', { name: 'Agree to the terms of service' })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toContainText('Default app');
});

test('reverts an agent\'s edits to the loaded version without leaving it', async ({ page }) => {
  const ready = page.locator('.preview-stage[data-phase="ready"]');
  await installModelContext(page);
  await page.goto('/');
  await expect(ready).toBeVisible({ timeout: 90_000 });

  const trigger = page.getByRole('button', { name: /^Version/ });
  const revert = page.getByRole('button', { name: 'Revert unpublished changes' });

  // Nothing to undo yet, so the control is inert rather than a second way to
  // load the app that is already loaded.
  await trigger.click();
  await expect(revert).toBeDisabled();
  await page.keyboard.press('Escape');

  // An agent edits the default app. This is the case the version list cannot
  // express: "Default app" is already the checked row.
  const files = await page.evaluate(async () => {
    const tools = (window as unknown as { __tools: { name: string; execute: (i: unknown) => Promise<unknown> }[] }).__tools;
    const list = tools.find((tool) => tool.name === 'list_project_files');
    return list!.execute({}) as Promise<{ revision: number }>;
  });
  await page.evaluate(async (revision) => {
    const tools = (window as unknown as { __tools: { name: string; execute: (i: unknown) => Promise<unknown> }[] }).__tools;
    const apply = tools.find((tool) => tool.name === 'apply_project_changes');
    await apply!.execute({
      baseRevision: revision,
      changes: [{
        path: 'src/components/HomeView.tsx',
        operation: 'write',
        content: "export default function HomeView() {\n  return <p className=\"lede\">Edited by an agent.</p>;\n}\n",
      }],
    });
  }, files.revision);

  const preview = page.frameLocator('iframe[title="Editable WebMCP application preview"]');
  await expect(preview.getByText('Edited by an agent.')).toBeVisible({ timeout: 60_000 });
  await expect(trigger).toContainText('edited');

  await trigger.click();
  await expect(revert).toBeEnabled();
  await revert.click();
  await page.getByRole('button', { name: 'Revert changes' }).click();

  // Back to the built-in app, still on the same version, and the dirty badge
  // is gone because the working copy matches what it was checked out from.
  await expect(preview.getByText('Edited by an agent.')).toHaveCount(0, { timeout: 60_000 });
  await expect(preview.getByRole('heading', { level: 1 }))
    .toContainText('See what happened in your care', { timeout: 30_000 });
  await expect(trigger).toContainText('Default app');
  await expect(trigger).not.toContainText('edited', { timeout: 30_000 });
});

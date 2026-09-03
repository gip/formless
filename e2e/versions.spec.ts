import { expect, test } from '@playwright/test';

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
  // The runtime pill, not the splash heading, is the signal the preview is live.
  const ready = page.locator('.preview-status.ready');
  await page.goto('/');
  await expect(ready).toBeVisible({ timeout: 90_000 });

  const trigger = page.getByRole('button', { name: /^Version/ });
  await expect(trigger).toContainText('Starter project');

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
  await page.getByRole('menuitem', { name: /Starter project/ }).click();
  await expect(trigger).toContainText('Starter project', { timeout: 30_000 });
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

import { expect, type FrameLocator } from '@playwright/test';

/**
 * Answers the starter's terms gate.
 *
 * Every route sits behind a modal dialog until the terms are accepted, so a test
 * that clicks anything inside the preview has to get past it exactly as a person
 * would. Acceptance is stored through `state.*` on the host origin and survives a
 * reload, but each test gets a fresh browser context — so each one answers once.
 *
 * Doubles as the boot signal: the dialog appears as soon as the guest is
 * mounted and has heard back from the host, which is why it carries the same
 * generous timeout the preview's first paint does.
 */
export async function acceptTerms(preview: FrameLocator): Promise<void> {
  const agree = preview.getByRole('button', { name: 'Agree and continue' });
  await expect(agree).toBeVisible({ timeout: 90_000 });
  await agree.click();
  await expect(agree).toHaveCount(0, { timeout: 10_000 });
}

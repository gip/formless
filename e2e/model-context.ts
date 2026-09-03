import type { Page } from '@playwright/test';

/**
 * Installs the minimal `document.modelContext` a WebMCP browser provides, so
 * tests drive the tools through the same native registration path the macOS
 * shell uses. Chromium exposes no WebMCP of its own.
 */
export async function installModelContext(page: Page) {
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

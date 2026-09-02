// WebMCP polyfill + native discovery bridge for the WebMCP Browser macOS shell.
//
// Injected at .atDocumentStart into WKContentWorld.page (the same JS realm the page's own
// scripts run in) for every frame. It defines document.modelContext, which no browser ships
// yet, and reports every registration out to Swift over the `webmcpBridge` message handler.
//
// Known simplification: `exposedTo` and the `tools` Permissions Policy are accepted and
// ignored, so every frame that asks gets a modelContext. That is fine for a local dev shell
// and wrong for a shipping browser.
(() => {
  if (document.modelContext) return; // idempotent per realm

  const registry = new Map(); // name -> tool

  const post = (message) => {
    try {
      window.webkit?.messageHandlers?.webmcpBridge?.postMessage(JSON.stringify(message));
    } catch {
      /* The native handler is absent (plain browser). Registration still works locally. */
    }
  };

  const stringifySafe = (value) => {
    if (value === undefined || value === null) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };

  const describe = (tool) => {
    const annotations = tool.annotations ?? null;
    return {
      name: String(tool.name),
      title: typeof tool.title === 'string' ? tool.title : null,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchemaJSON: stringifySafe(tool.inputSchema),
      annotationsJSON: stringifySafe(annotations),
      readOnlyHint: typeof annotations?.readOnlyHint === 'boolean' ? annotations.readOnlyHint : null,
      untrustedContentHint:
        typeof annotations?.untrustedContentHint === 'boolean' ? annotations.untrustedContentHint : null,
    };
  };

  const emitToolChange = () => {
    try {
      document.dispatchEvent(new Event('toolchange'));
    } catch {
      /* Older event constructors are not a reason to fail a registration. */
    }
  };

  document.modelContext = {
    // Returns a Promise: pages await it, or wrap it in Promise.resolve.
    registerTool(tool, options = {}) {
      if (!tool || typeof tool.name !== 'string' || !tool.name || typeof tool.execute !== 'function') {
        return Promise.reject(new TypeError('registerTool requires a name and an execute function.'));
      }
      if (registry.has(tool.name)) {
        return Promise.reject(new Error(`Duplicate WebMCP tool: ${tool.name}`));
      }

      registry.set(tool.name, tool);

      // Registration lifetime is owned by the caller's AbortSignal; there is no name-based
      // unregisterTool in the current draft.
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) {
          registry.delete(tool.name);
          return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }
        signal.addEventListener(
          'abort',
          () => {
            registry.delete(tool.name);
            post({ type: 'unregistered', name: tool.name });
            emitToolChange();
          },
          { once: true },
        );
      }

      post({ type: 'registered', tool: describe(tool) });
      emitToolChange();
      return Promise.resolve();
    },
  };

  // Channel 2: Swift calls this by name. Arguments and results cross as JSON strings so no
  // undefined / NaN / Date value has to survive the WKWebView object bridge.
  window.__webmcpInvoke = async (name, argsJSON) => {
    const tool = registry.get(name);
    if (!tool) return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    const controller = new AbortController();
    try {
      const input = JSON.parse(argsJSON || '{}');
      const result = await tool.execute(input, { signal: controller.signal });
      return JSON.stringify({ ok: true, result: result ?? null });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
    }
  };

  // Resync hook: lets Swift re-read the live registry without waiting for a new registration.
  window.__webmcpList = () => JSON.stringify([...registry.values()].map(describe));

  post({ type: 'ready' });
})();

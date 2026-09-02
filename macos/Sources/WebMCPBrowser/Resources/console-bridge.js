// Forwards console output and uncaught errors to the native side, so the app can show why a
// page failed without attaching Web Inspector. Injected at .atDocumentStart in the page world.
(() => {
  if (window.__webmcpConsoleInstalled) return;
  window.__webmcpConsoleInstalled = true;

  const post = (entry) => {
    try {
      window.webkit?.messageHandlers?.consoleBridge?.postMessage(JSON.stringify(entry));
    } catch {
      /* No native host: leave the page's own console untouched. */
    }
  };

  const describe = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };

  const format = (args) => {
    const text = Array.from(args, describe).join(' ');
    return text.length > 4000 ? `${text.slice(0, 4000)}… (truncated)` : text;
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]?.bind(console);
    console[level] = (...args) => {
      post({ type: 'console', level, text: format(args) });
      original?.(...args);
    };
  }

  window.addEventListener('error', (event) => {
    post({
      type: 'console',
      level: 'uncaught',
      text: `${event.message} (${event.filename ?? '?'}:${event.lineno ?? 0})`,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    post({ type: 'console', level: 'rejection', text: describe(event.reason) });
  });
})();

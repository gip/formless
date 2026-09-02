// Contract test for webmcp-polyfill.js. Runs in plain node, no browser required:
//   node macos/Tests/polyfill.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'Sources', 'WebMCPBrowser', 'Resources', 'webmcp-polyfill.js'), 'utf8');

const posted = [];
globalThis.document = { dispatchEvent() {} };
globalThis.window = {
  webkit: { messageHandlers: { webmcpBridge: { postMessage: (json) => posted.push(JSON.parse(json)) } } },
};
globalThis.Event = class { constructor(type) { this.type = type; } };

new Function(source)();

const types = () => posted.map((m) => m.type);
assert.deepEqual(types(), ['ready'], 'the polyfill announces itself on install');
assert.ok(document.modelContext?.registerTool, 'document.modelContext is defined');

// Registration reports name, description, schema and annotations.
const lifetime = new AbortController();
await document.modelContext.registerTool({
  name: 'demo.echo',
  title: 'Echo',
  description: 'Echoes input.',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  annotations: { readOnlyHint: true, untrustedContentHint: false },
  async execute(input, { signal }) {
    signal.throwIfAborted();
    return { echoed: input.message };
  },
}, { signal: lifetime.signal });

const registered = posted.at(-1);
assert.equal(registered.type, 'registered');
assert.equal(registered.tool.name, 'demo.echo');
assert.equal(registered.tool.title, 'Echo');
assert.equal(registered.tool.readOnlyHint, true);
assert.equal(registered.tool.untrustedContentHint, false);
assert.equal(JSON.parse(registered.tool.inputSchemaJSON).properties.message.type, 'string');

// execute receives (input, { signal }) and results come back as a JSON string.
const ok = JSON.parse(await window.__webmcpInvoke('demo.echo', JSON.stringify({ message: 'hi' })));
assert.deepEqual(ok, { ok: true, result: { echoed: 'hi' } });

// Quotes and backslashes survive, because arguments never touch the JS source.
const tricky = String.raw`he said "hi" \ back\slash`;
const quoted = JSON.parse(await window.__webmcpInvoke('demo.echo', JSON.stringify({ message: tricky })));
assert.equal(quoted.result.echoed, tricky);

// Unknown names and throwing tools are reported, never crashed on.
assert.deepEqual(JSON.parse(await window.__webmcpInvoke('nope', '{}')), {
  ok: false, error: 'Unknown tool: nope',
});

await document.modelContext.registerTool({
  name: 'demo.explode',
  description: 'Throws.',
  async execute() { throw new Error('boom'); },
});
assert.deepEqual(JSON.parse(await window.__webmcpInvoke('demo.explode', '{}')), { ok: false, error: 'boom' });

// Duplicate names are rejected: exactly one active registration per name.
await assert.rejects(
  document.modelContext.registerTool({ name: 'demo.echo', description: '', async execute() {} }),
  /Duplicate WebMCP tool: demo.echo/);

// __webmcpList is the resync hook.
assert.deepEqual(JSON.parse(window.__webmcpList()).map((t) => t.name), ['demo.echo', 'demo.explode']);

// Aborting the registration signal removes the tool and reports it.
lifetime.abort();
assert.deepEqual(posted.at(-1), { type: 'unregistered', name: 'demo.echo' });
assert.deepEqual(JSON.parse(window.__webmcpList()).map((t) => t.name), ['demo.explode']);
assert.deepEqual(JSON.parse(await window.__webmcpInvoke('demo.echo', '{}')), {
  ok: false, error: 'Unknown tool: demo.echo',
});

// An already-aborted signal never registers at all.
assert.equal(posted.filter((m) => m.type === 'registered').length, 2);
await assert.rejects(document.modelContext.registerTool(
  { name: 'demo.stillborn', description: '', async execute() {} },
  { signal: AbortSignal.abort() }));
assert.equal(posted.filter((m) => m.type === 'registered').length, 2);

// Bad definitions are rejected without poisoning the registry.
await assert.rejects(document.modelContext.registerTool({ name: 'no.execute' }), TypeError);

console.log('webmcp-polyfill.js: all contract assertions passed');

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { isTrustedPreviewMessage } from '@/lib/bridge';
import { BRIDGE_PROTOCOL, type ToolDefinition, type UiElementDescriptor, type UserMessage } from '@/lib/canvas-types';
import { UserMessageQueue } from '@/lib/message-queue';
import { getProjectController, type ControllerState } from '@/lib/project-controller';
import { createCanvasTools, registerNativeTools } from '@/lib/webmcp-tools';

const initialControllerState: ControllerState = {
  phase: 'idle',
  detail: 'Preparing the canvas',
  revision: 0,
  previewUrl: null,
};

const phaseLabels: Record<ControllerState['phase'], string> = {
  idle: 'Waiting',
  restoring: 'Restoring source',
  booting: 'Booting runtime',
  hydrating: 'Loading runtime',
  mounting: 'Mounting project',
  installing: 'Installing packages',
  starting: 'Starting preview',
  ready: 'Canvas ready',
  validating: 'Validating update',
  error: 'Runtime unavailable',
};

export default function CanvasApp() {
  const controller = useMemo(() => getProjectController(), []);
  const messageQueue = useMemo(() => new UserMessageQueue(50), []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const elementsRef = useRef<UiElementDescriptor[]>([]);
  const [runtime, setRuntime] = useState(initialControllerState);
  const [elements, setElements] = useState<UiElementDescriptor[]>([]);
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [coverage, setCoverage] = useState<'waiting' | 'valid' | 'invalid'>('waiting');
  const [nativeWebMcp, setNativeWebMcp] = useState(false);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [selectedTool, setSelectedTool] = useState('get_ui_elements');
  const [toolInput, setToolInput] = useState('{}');
  const [toolOutput, setToolOutput] = useState('Run a tool to inspect its response.');
  const [toolBusy, setToolBusy] = useState(false);

  const previewOrigin = useMemo(() => {
    if (!runtime.previewUrl) return null;
    try { return new URL(runtime.previewUrl).origin; } catch { return null; }
  }, [runtime.previewUrl]);

  useEffect(() => controller.subscribe(setRuntime), [controller]);

  useEffect(() => {
    void controller.boot().catch(() => undefined);
  }, [controller]);

  useEffect(() => {
    elementsRef.current = elements;
  }, [elements]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedPreviewMessage(event, iframeRef.current?.contentWindow ?? null, previewOrigin)) return;
      const payload = event.data.payload as Record<string, unknown> | undefined;
      if (event.data.type === 'registry' && Array.isArray(payload?.elements)) {
        setElements(payload.elements as UiElementDescriptor[]);
      }
      if (event.data.type === 'coverage') {
        setCoverage(payload?.valid === true ? 'valid' : 'invalid');
      }
      if (event.data.type === 'user-message' && typeof payload?.text === 'string' && (payload.source === 'typed' || payload.source === 'speech')) {
        try {
          messageQueue.add(payload.text, payload.source);
          setMessages(messageQueue.all());
        } catch { /* Empty preview messages are ignored. */ }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [messageQueue, previewOrigin]);

  useEffect(() => {
    const sendPreviewCommand = (type: 'highlight' | 'clear-highlight', payload: Record<string, unknown> = {}) => {
      if (!iframeRef.current?.contentWindow || !previewOrigin) throw new Error('The live preview is not ready.');
      iframeRef.current.contentWindow.postMessage({ protocol: BRIDGE_PROTOCOL, type, payload }, previewOrigin);
    };
    const definitions = createCanvasTools({
      project: controller,
      messages: messageQueue,
      getElements: () => elementsRef.current,
      sendPreviewCommand,
    });
    setTools(definitions);
    const registration = registerNativeTools(definitions);
    setNativeWebMcp(registration.native);
    return registration.dispose;
  }, [controller, messageQueue, previewOrigin]);

  async function runTool() {
    const definition = tools.find((candidate) => candidate.name === selectedTool);
    if (!definition) return;
    setToolBusy(true);
    try {
      const input = JSON.parse(toolInput || '{}') as Record<string, unknown>;
      const result = await definition.execute(input);
      setToolOutput(JSON.stringify(result, null, 2));
      setRuntime(controller.getState());
    } catch (error) {
      setToolOutput(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Invalid tool input.' }, null, 2));
    } finally {
      setToolBusy(false);
    }
  }

  async function resetProject() {
    if (!window.confirm('Reset the editable preview to the starter project? Your saved local changes will be replaced.')) return;
    const definition = tools.find((candidate) => candidate.name === 'reset_project');
    if (!definition) return;
    setToolBusy(true);
    const result = await definition.execute({ baseRevision: runtime.revision, confirm: true });
    setToolOutput(JSON.stringify(result, null, 2));
    setRuntime(controller.getState());
    setToolBusy(false);
  }

  return (
    <main className="canvas-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">W</div>
        <div className="brand-copy">
          <p className="eyebrow">WebAlly</p>
          <h1>Agent-ready interface lab</h1>
        </div>
        <div className={`connection-pill ${nativeWebMcp ? 'online' : ''}`}>
          <span /> {nativeWebMcp ? 'Native WebMCP connected' : 'Local test bridge only'}
        </div>
      </header>

      <section className="workspace" aria-label="WebAlly workspace">
        <div className="preview-stage">
          <div className="preview-toolbar">
            <span className="browser-dot red" /><span className="browser-dot amber" /><span className="browser-dot green" />
            <span className="preview-label">Live WebContainer preview</span>
            <span className={`preview-status ${runtime.phase}`}><i />{phaseLabels[runtime.phase]}</span>
          </div>
          <div className="preview-viewport">
            {runtime.previewUrl ? (
              <iframe
                ref={iframeRef}
                key={runtime.previewUrl}
                src={`${runtime.previewUrl}/?canvasHost=${encodeURIComponent(window.location.origin)}`}
                title="Editable WebMCP application preview"
                allow="microphone; cross-origin-isolated; tools"
              />
            ) : (
              <div className={`runtime-splash ${runtime.phase === 'error' ? 'failed' : ''}`}>
                <div className="runtime-orbit"><span /><i /></div>
                <p className="eyebrow">In-browser runtime</p>
                <h2>{runtime.phase === 'error' ? 'The preview could not start' : 'Building your live canvas'}</h2>
                <p>{runtime.detail}</p>
                {runtime.phase === 'error' && <small>Use a Chromium browser with cross-origin isolation and third-party storage enabled.</small>}
              </div>
            )}
          </div>
        </div>

        <aside className="rail">
          <section className="rail-block runtime-block">
            <div className="section-heading"><div><p className="eyebrow">Runtime</p><h2>{phaseLabels[runtime.phase]}</h2></div><span className={`runtime-number ${runtime.phase}`}>{runtime.phase === 'ready' ? '✓' : '01'}</span></div>
            <p className="runtime-detail">{runtime.detail}</p>
            <div className="metric-grid">
              <div><strong>{runtime.revision}</strong><span>Revision</span></div>
              <div><strong>{elements.length}</strong><span>UI elements</span></div>
            </div>
            <div className="micro-statuses">
              <span className={nativeWebMcp ? 'good' : 'warn'}><i />{nativeWebMcp ? 'Native tools exposed' : 'Compatibility adapter'}</span>
              <span className={coverage === 'invalid' ? 'bad' : coverage === 'valid' ? 'good' : ''}><i />Instrumentation {coverage}</span>
            </div>
          </section>

          <section className="rail-block messages-block">
            <div className="section-heading"><div><p className="eyebrow">Agent inbox</p><h2>User messages</h2></div><span className="count-pill">{messages.length}</span></div>
            <div className="message-list" aria-live="polite">
              {messages.length === 0 ? <p className="empty-state">Typed prompts and final speech transcripts will appear here.</p> : messages.slice(-4).reverse().map((message) => (
                <article className="message-card" key={message.id}>
                  <div><span className={`source-dot ${message.source}`} />{message.source}</div>
                  <p>{message.text}</p>
                  <small>#{message.id}</small>
                </article>
              ))}
            </div>
          </section>

          <details className="rail-block tool-console">
            <summary><span><span className="eyebrow">Local bridge</span><strong>Tool console</strong></span><span aria-hidden="true">＋</span></summary>
            <label>Tool<select value={selectedTool} onChange={(event) => setSelectedTool(event.target.value)}>{tools.map((definition) => <option key={definition.name}>{definition.name}</option>)}</select></label>
            <label>JSON arguments<textarea rows={5} value={toolInput} onChange={(event) => setToolInput(event.target.value)} spellCheck={false} /></label>
            <button type="button" onClick={runTool} disabled={toolBusy || tools.length === 0}>{toolBusy ? 'Running…' : 'Run tool'}</button>
            <pre>{toolOutput}</pre>
          </details>

          <section className="rail-footer">
            <div><span>Project source</span><strong>Revision {runtime.revision} · saved locally</strong></div>
            <button type="button" onClick={resetProject} disabled={toolBusy || runtime.phase !== 'ready'}>Reset</button>
          </section>
        </aside>
      </section>
    </main>
  );
}

import type { FileMap } from './canvas-types';

// Two details in the guest package.json exist to keep the prebuilt runtime in
// `public/guest-runtime/` usable (see lib/runtime-snapshot.ts):
//   - scripts call `node node_modules/<pkg>/…` instead of the bare binary,
//     because a remounted snapshot loses the executable bit on node_modules/.bin
//     and `npm run dev` would fail with `jsh: spawn vite EACCES`.
//   - @rolldown/binding-wasm32-wasi is pinned to rolldown's version so vite does
//     not stop to download it on every dev-server start (~2.5s).
export const STARTER_FILES: FileMap = {
  'package.json': `{
  "name": "webmcp-canvas-preview",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "node node_modules/vite/bin/vite.js --host 0.0.0.0",
    "build": "node node_modules/vite/bin/vite.js build",
    "typecheck": "node node_modules/typescript/bin/tsc --noEmit",
    "audit-ui": "node scripts/audit-ui.mjs",
    "validate": "npm run audit-ui && node scripts/validate-syntax.mjs"
  },
  "dependencies": {
    "@vitejs/plugin-react": "6.1.0",
    "vite": "8.2.2",
    "@rolldown/binding-wasm32-wasi": "1.2.6",
    "typescript": "5.9.3",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3"
  }
}`,
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#142235" />
    <title>Agent-ready workspace</title>
  </head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}`,
  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0' },
});`,
  'src/vite-env.d.ts': `/// <reference types="vite/client" />`,
  'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);`,
  'src/agent/bridge.tsx': `import {
  cloneElement,
  createElement,
  forwardRef,
  isValidElement,
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactElement,
  type Ref,
} from 'react';

const PROTOCOL = 'webmcp-canvas/v1';
const registry = new Map<string, HTMLElement>();
const descriptors = new Map<string, TargetDescriptor>();
const requestedHost = new URLSearchParams(window.location.search).get('canvasHost');
const hostOrigin = requestedHost ? new URL(requestedHost).origin : '*';

export interface TargetDescriptor {
  id: string;
  label: string;
  description: string;
  role: string;
  visible: boolean;
  enabled: boolean;
  kind: string;
}

interface AgentTargetProps {
  agentId: string;
  label: string;
  description?: string;
  children: ReactElement<Record<string, unknown>>;
}

function post(type: string, payload: unknown) {
  window.parent.postMessage({ protocol: PROTOCOL, type, payload }, hostOrigin);
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HIGHLIGHT_OVERLAY_ID = 'agent-highlight-overlay';
const HIGHLIGHT_MASK_ID = 'agent-highlight-mask';

interface ActiveHighlight {
  ids: Set<string>;
  color: string;
  alternateColor: string | null;
  restTreatment: 'dim' | 'hide';
  dimOpacity: number;
}

let activeHighlight: ActiveHighlight | null = null;
let highlightTimeout: number | null = null;
let blinkInterval: number | null = null;
let geometryFrame: number | null = null;
let highlightResizeObserver: ResizeObserver | null = null;

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function getHighlightOverlay(): SVGSVGElement {
  const existing = document.getElementById(HIGHLIGHT_OVERLAY_ID);
  if (existing instanceof SVGSVGElement) return existing;

  const overlay = svgElement('svg');
  overlay.id = HIGHLIGHT_OVERLAY_ID;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('focusable', 'false');
  overlay.style.setProperty('position', 'fixed', 'important');
  overlay.style.setProperty('inset', '0', 'important');
  overlay.style.setProperty('display', 'block', 'important');
  overlay.style.setProperty('width', '100vw', 'important');
  overlay.style.setProperty('height', '100vh', 'important');
  overlay.style.setProperty('max-width', 'none', 'important');
  overlay.style.setProperty('max-height', 'none', 'important');
  overlay.style.setProperty('z-index', '2147483646', 'important');
  overlay.style.setProperty('overflow', 'visible', 'important');
  overlay.style.setProperty('opacity', '1', 'important');
  overlay.style.setProperty('visibility', 'visible', 'important');
  overlay.style.setProperty('pointer-events', 'none', 'important');
  overlay.style.setProperty('transform', 'none', 'important');
  overlay.style.setProperty('filter', 'none', 'important');

  const definitions = svgElement('defs');
  const mask = svgElement('mask');
  mask.id = HIGHLIGHT_MASK_ID;
  mask.dataset.agentMask = 'true';
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  definitions.append(mask);

  const backdrop = svgElement('rect');
  backdrop.dataset.agentBackdrop = 'true';
  backdrop.style.setProperty('fill', '#ffffff', 'important');
  backdrop.style.setProperty('mask', 'url(#' + HIGHLIGHT_MASK_ID + ')', 'important');

  const outlines = svgElement('g');
  outlines.dataset.agentOutlines = 'true';
  overlay.append(definitions, backdrop, outlines);
  document.body.append(overlay);
  return overlay;
}

function updateHighlightGeometry() {
  geometryFrame = null;
  if (!activeHighlight) return;

  const overlay = getHighlightOverlay();
  const width = window.innerWidth;
  const height = window.innerHeight;
  overlay.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  overlay.setAttribute('width', String(width));
  overlay.setAttribute('height', String(height));

  const mask = overlay.querySelector('[data-agent-mask]');
  const backdrop = overlay.querySelector('[data-agent-backdrop]');
  const outlines = overlay.querySelector('[data-agent-outlines]');
  if (!mask || !backdrop || !outlines) return;

  const maskBase = svgElement('rect');
  maskBase.setAttribute('width', String(width));
  maskBase.setAttribute('height', String(height));
  maskBase.style.setProperty('fill', '#ffffff', 'important');
  const holes: SVGRectElement[] = [];
  const outlineRects: SVGRectElement[] = [];

  activeHighlight.ids.forEach((id) => {
    const node = registry.get(id);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const radius = Math.min(parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2);

    const hole = svgElement('rect');
    hole.setAttribute('x', String(rect.left));
    hole.setAttribute('y', String(rect.top));
    hole.setAttribute('width', String(rect.width));
    hole.setAttribute('height', String(rect.height));
    hole.setAttribute('rx', String(radius));
    hole.style.setProperty('fill', '#000000', 'important');
    holes.push(hole);

    const outline = svgElement('rect');
    outline.setAttribute('x', String(rect.left - 5));
    outline.setAttribute('y', String(rect.top - 5));
    outline.setAttribute('width', String(rect.width + 10));
    outline.setAttribute('height', String(rect.height + 10));
    outline.setAttribute('rx', String(radius + 5));
    outline.style.setProperty('fill', 'var(--agent-active-color, #d9ff63)', 'important');
    outline.style.setProperty('fill-opacity', '.1', 'important');
    outline.style.setProperty('stroke', 'var(--agent-active-color, #d9ff63)', 'important');
    outline.style.setProperty('stroke-width', '4px', 'important');
    outline.style.setProperty('vector-effect', 'non-scaling-stroke', 'important');
    outline.style.setProperty('filter', 'drop-shadow(0 0 7px var(--agent-active-color, #d9ff63))', 'important');
    outline.style.setProperty('transition', 'fill .08s linear, stroke .08s linear', 'important');
    outlineRects.push(outline);
  });

  mask.replaceChildren(maskBase, ...holes);
  outlines.replaceChildren(...outlineRects);
  backdrop.setAttribute('width', String(width));
  backdrop.setAttribute('height', String(height));
  backdrop.style.setProperty('opacity', String(activeHighlight.restTreatment === 'hide' ? 1 : 1 - activeHighlight.dimOpacity), 'important');
}

function scheduleHighlightGeometry() {
  if (!activeHighlight || geometryFrame !== null) return;
  geometryFrame = window.requestAnimationFrame(updateHighlightGeometry);
}

function observeHighlightedNodes() {
  highlightResizeObserver?.disconnect();
  highlightResizeObserver = null;
  if (!activeHighlight || typeof ResizeObserver === 'undefined') return;
  highlightResizeObserver = new ResizeObserver(scheduleHighlightGeometry);
  activeHighlight.ids.forEach((id) => {
    const node = registry.get(id);
    if (node) highlightResizeObserver?.observe(node);
  });
}

function clearHighlight(announce = true) {
  if (highlightTimeout !== null) window.clearTimeout(highlightTimeout);
  if (blinkInterval !== null) window.clearInterval(blinkInterval);
  if (geometryFrame !== null) window.cancelAnimationFrame(geometryFrame);
  highlightTimeout = null;
  blinkInterval = null;
  geometryFrame = null;
  activeHighlight = null;
  highlightResizeObserver?.disconnect();
  highlightResizeObserver = null;
  document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
  registry.forEach((node) => {
    node.classList.remove('agent-selected', 'agent-dimmed', 'agent-hidden');
    node.style.removeProperty('--agent-color');
    node.style.removeProperty('--agent-dim-opacity');
  });
  if (announce) {
    const announcer = document.getElementById('agent-announcer');
    if (announcer) announcer.textContent = 'Highlight cleared.';
  }
}

window.addEventListener('resize', scheduleHighlightGeometry);
window.addEventListener('scroll', scheduleHighlightGeometry, true);

function publishRegistry() {
  const elements = Array.from(descriptors.values()).map((descriptor) => {
    const node = registry.get(descriptor.id);
    const rect = node?.getBoundingClientRect();
    return {
      ...descriptor,
      visible: Boolean(node && rect && rect.width > 0 && rect.height > 0),
      enabled: node ? !(node as HTMLButtonElement).disabled : false,
    };
  });
  post('registry', { generation: Date.now(), elements });
  scheduleHighlightGeometry();
  observeHighlightedNodes();
}

export function AgentTarget({ agentId, label, description = '', children }: AgentTargetProps) {
  const nodeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    if (registry.has(agentId) && registry.get(agentId) !== node) {
      throw new Error('Duplicate agent target id: ' + agentId);
    }
    registry.set(agentId, node);
    descriptors.set(agentId, {
      id: agentId,
      label,
      description,
      role: node.getAttribute('role') || node.tagName.toLowerCase(),
      visible: true,
      enabled: !(node as HTMLButtonElement).disabled,
      kind: node.tagName.toLowerCase(),
    });
    publishRegistry();
    return () => {
      registry.delete(agentId);
      descriptors.delete(agentId);
      publishRegistry();
    };
  }, [agentId, label, description]);

  if (!isValidElement(children)) return children;
  return cloneElement(children, {
    ref: nodeRef,
    'data-agent-target': 'true',
    'data-agent-id': agentId,
    'aria-label': (children.props['aria-label'] as string | undefined) || label,
  });
}

export function withAgentTarget<T extends ElementType>(Component: T) {
  type Props = ComponentPropsWithoutRef<T> & {
    agentId: string;
    agentLabel: string;
    agentDescription?: string;
  };
  return forwardRef<HTMLElement, Props>(function InstrumentedComponent(props, forwardedRef) {
    const { agentId, agentLabel, agentDescription, ...componentProps } = props;
    const element = createElement(Component as ElementType, { ...componentProps, ref: forwardedRef }) as ReactElement<Record<string, unknown>>;
    return (
      <AgentTarget agentId={agentId} label={agentLabel} description={agentDescription}>
        {element}
      </AgentTarget>
    );
  });
}

export const AgentButton = withAgentTarget('button');
export const AgentInput = withAgentTarget('input');

export function sendUserMessage(text: string, source: 'typed' | 'speech') {
  const normalized = text.trim();
  if (normalized) post('user-message', { text: normalized, source });
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (hostOrigin !== '*' && event.origin !== hostOrigin) return;
  const data = event.data as { protocol?: string; type?: string; payload?: Record<string, unknown> };
  if (data?.protocol !== PROTOCOL) return;

  if (data.type === 'highlight') {
    clearHighlight(false);
    const ids = new Set(Array.isArray(data.payload?.elementIds) ? data.payload?.elementIds as string[] : []);
    const requestedColor = typeof data.payload?.color === 'string' ? data.payload.color : '';
    const color = /^#[0-9a-f]{6}$/i.test(requestedColor) ? requestedColor : '#D9FF63';
    const requestedAlternateColor = typeof data.payload?.alternateColor === 'string' ? data.payload.alternateColor : '';
    const alternateColor = /^#[0-9a-f]{6}$/i.test(requestedAlternateColor) ? requestedAlternateColor : null;
    const treatment = data.payload?.restTreatment === 'hide' ? 'hide' : 'dim';
    const requestedOpacity = typeof data.payload?.dimOpacity === 'number' ? data.payload.dimOpacity : 0.24;
    const opacity = Math.min(0.8, Math.max(0.1, requestedOpacity));
    const requestedBlinkInterval = typeof data.payload?.blinkIntervalMs === 'number' ? data.payload.blinkIntervalMs : 500;
    const blinkIntervalMs = Math.min(5000, Math.max(100, requestedBlinkInterval));
    const requestedDuration = typeof data.payload?.durationSeconds === 'number' ? data.payload.durationSeconds : null;
    const durationSeconds = requestedDuration && requestedDuration > 0 ? Math.min(300, requestedDuration) : null;

    activeHighlight = { ids, color, alternateColor, restTreatment: treatment, dimOpacity: opacity };
    const overlay = getHighlightOverlay();
    overlay.style.setProperty('--agent-active-color', color);
    updateHighlightGeometry();
    observeHighlightedNodes();

    if (alternateColor) {
      let showAlternate = false;
      blinkInterval = window.setInterval(() => {
        showAlternate = !showAlternate;
        overlay.style.setProperty('--agent-active-color', showAlternate ? alternateColor : color);
      }, blinkIntervalMs);
    }
    if (durationSeconds) {
      highlightTimeout = window.setTimeout(() => clearHighlight(), durationSeconds * 1000);
    }

    const labels = Array.from(ids).map((id) => descriptors.get(id)?.label || id);
    const announcer = document.getElementById('agent-announcer');
    if (announcer) {
      const timing = durationSeconds ? ' for ' + durationSeconds + ' seconds' : '';
      const blinking = alternateColor ? ', blinking between ' + color + ' and ' + alternateColor : '';
      announcer.textContent = 'Highlighted' + timing + ': ' + labels.join(', ') + blinking;
    }
  }

  if (data.type === 'clear-highlight') {
    clearHighlight();
  }
});

window.addEventListener('load', () => {
  const uncovered = Array.from(document.querySelectorAll('button,input,textarea,select,a[href],[role="button"]'))
    .filter((node) => !(node as HTMLElement).dataset.agentTarget)
    .map((node) => node.tagName.toLowerCase());
  post('coverage', { valid: uncovered.length === 0, uncovered });
  publishRegistry();
});`,
  'src/App.tsx': `import { FormEvent, useMemo, useRef, useState } from 'react';
import { AgentButton, AgentInput, AgentTarget, sendUserMessage } from './agent/bridge';

type RecognitionEvent = Event & { results: { length: number; [key: number]: { isFinal: boolean; 0: { transcript: string } } } };
type RecognitionErrorEvent = Event & { error: string; message?: string };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('Ready for your next idea.');
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const RecognitionCtor = useMemo(() => window.SpeechRecognition || window.webkitSpeechRecognition, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    sendUserMessage(prompt, 'typed');
    setNotice('Sent to the agent queue.');
    setPrompt('');
  }

  function toggleSpeech() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    if (!RecognitionCtor) {
      setNotice('Speech recognition is unavailable in this browser. You can still type.');
      return;
    }
    const recognition = new RecognitionCtor();
    recognition.lang = navigator.language;
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      for (let index = 0; index < event.results.length; index += 1) {
        if (!event.results[index].isFinal) continue;
        const transcript = event.results[index][0].transcript.trim();
        setPrompt(transcript);
        sendUserMessage(transcript, 'speech');
        setNotice('Speech captured and sent to the agent queue.');
      }
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      setListening(false);
      setNotice('Speech recognition failed: ' + (event.error || 'unknown error') + '.');
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
    setNotice('Listening… tap again to stop.');
  }

  return (
    <main className="demo-page">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <AgentTarget agentId="workspace-card" label="Workspace introduction" description="Explains how to work with the agent-ready canvas.">
        <section className="hero-card">
          <div className="hero-topline">
            <span className="signal"><i /> Agent-ready workspace</span>
            <span className="element-count">7 elements exposed</span>
          </div>
          <h1>What should we<br />build together?</h1>
          <AgentTarget agentId="intro-copy" label="Workspace instructions" description="Short guidance for the user.">
            <p className="intro">Type an instruction or speak naturally. Every control on this canvas has a stable identity your browser agent can discover and highlight.</p>
          </AgentTarget>

          <form className="prompt-form" onSubmit={submit}>
            <AgentInput
              agentId="prompt-input"
              agentLabel="Instruction text box"
              agentDescription="Enter a message for the browser agent."
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              placeholder="Describe a change…"
            />
            <AgentButton agentId="send-prompt" agentLabel="Send to agent" agentDescription="Queues the typed instruction for the agent." type="submit">
              Ask agent <span aria-hidden="true">↗</span>
            </AgentButton>
          </form>

          <div className="quick-actions">
            <AgentButton agentId="save-draft" agentLabel="Save draft" agentDescription="Demonstration action for saving the current draft." type="button" onClick={() => setNotice('Draft saved locally.')}>Save draft</AgentButton>
            <AgentButton agentId="share-preview" agentLabel="Share preview" agentDescription="Demonstration action for sharing this preview." type="button" onClick={() => setNotice('Preview link copied for this demo.')}>Share preview</AgentButton>
            <AgentButton agentId="toggle-speech" agentLabel={listening ? 'Stop listening' : 'Speak'} agentDescription="Starts or stops speech recognition." type="button" className={listening ? 'speech active' : 'speech'} onClick={toggleSpeech}>
              <span className="mic-dot" aria-hidden="true" /> {listening ? 'Stop listening' : 'Speak'}
            </AgentButton>
          </div>

          <div className="notice" role="status" aria-live="polite"><span />{notice}</div>
          <div id="agent-announcer" className="sr-only" aria-live="polite" />
        </section>
      </AgentTarget>
    </main>
  );
}`,
  'src/styles/app.css': `:root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f6f8fb; background: #e9edf1; font-synthesis: none; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input { font: inherit; }
.demo-page { position: relative; min-height: 100vh; display: grid; place-items: center; overflow: hidden; padding: 42px; background: linear-gradient(145deg, #e7ebef, #f5f5f0); }
.ambient { position: absolute; border-radius: 999px; filter: blur(2px); opacity: .75; }
.ambient-one { width: 280px; height: 280px; top: -120px; right: -60px; background: #cdd8ff; }
.ambient-two { width: 200px; height: 200px; bottom: -90px; left: -50px; background: #e8ff99; }
.hero-card { position: relative; width: min(820px, 100%); padding: clamp(34px, 7vw, 78px); overflow: hidden; border-radius: 32px; background: #142235; box-shadow: 0 30px 90px rgba(20,34,53,.24); }
.hero-card::after { content: ''; position: absolute; width: 260px; height: 260px; top: -110px; right: -90px; border: 1px solid rgba(217,255,99,.2); border-radius: 50%; box-shadow: 0 0 0 45px rgba(217,255,99,.03), 0 0 0 90px rgba(217,255,99,.025); pointer-events: none; }
.hero-topline { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
.signal { color: #d9ff63; }.signal i { display: inline-block; width: 7px; height: 7px; margin-right: 9px; border-radius: 50%; background: #d9ff63; box-shadow: 0 0 0 5px rgba(217,255,99,.12); }
.element-count { color: #8592a3; }
h1 { max-width: 680px; margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: clamp(44px, 8vw, 82px); line-height: .94; letter-spacing: -.065em; }
.intro { max-width: 600px; margin: 26px 0 38px; color: #b9c3cf; font-size: clamp(15px, 2vw, 18px); line-height: 1.65; }
.prompt-form { display: flex; gap: 8px; padding: 7px; border-radius: 16px; background: white; box-shadow: 0 10px 30px rgba(0,0,0,.15); }
.prompt-form input { min-width: 0; flex: 1; padding: 14px 15px; border: 0; outline: 0; color: #142235; background: transparent; }
.prompt-form input::placeholder { color: #929cab; }
.prompt-form button { border: 0; border-radius: 11px; padding: 13px 18px; background: #d9ff63; color: #142235; font-weight: 800; cursor: pointer; }
.quick-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; }
.quick-actions button { padding: 12px 16px; border: 1px solid #34465c; border-radius: 11px; color: #edf2f7; background: #213248; font-weight: 700; cursor: pointer; transition: transform .18s, background .18s; }
.quick-actions button:hover { transform: translateY(-1px); background: #2a3d55; }
.quick-actions .speech { margin-left: auto; border-color: #4775ff; background: #3867f4; }.quick-actions .speech.active { background: #d95a55; border-color: #ed7772; }
.mic-dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: currentColor; }
.notice { display: flex; align-items: center; gap: 8px; margin-top: 25px; color: #8492a4; font-size: 12px; }.notice span { width: 5px; height: 5px; border-radius: 50%; background: #5fdd8b; }
#agent-highlight-overlay { position: fixed; inset: 0; z-index: 2147483646; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
.agent-highlight-outline { fill: var(--agent-active-color, #d9ff63); fill-opacity: .1; stroke: var(--agent-active-color, #d9ff63); stroke-width: 4px; vector-effect: non-scaling-stroke; filter: drop-shadow(0 0 7px var(--agent-active-color, #d9ff63)); transition: fill .08s linear, stroke .08s linear; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 620px) { .demo-page { padding: 16px; }.hero-card { border-radius: 22px; }.prompt-form { flex-direction: column; }.quick-actions .speech { margin-left: 0; }.element-count { display: none; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`,
  'scripts/audit-ui.mjs': `import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\\.(tsx|jsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = (await walk('src')).filter((path) => !path.includes('/agent/'));
const violations = [];
const ids = new Map();
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (/<(button|input|textarea|select|a)(\\s|>)/.test(source)) violations.push(file + ': raw interactive JSX element');
  for (const match of source.matchAll(/agentId=["']([^"']+)["']/g)) {
    const prior = ids.get(match[1]);
    if (prior) violations.push(file + ': duplicate agentId "' + match[1] + '" also in ' + prior);
    else ids.set(match[1], file);
  }
}
if (violations.length) {
  console.error('Agent instrumentation audit failed:\\n' + violations.join('\\n'));
  process.exit(1);
}
console.log('Agent instrumentation audit passed for ' + ids.size + ' targets.');`,
  'scripts/validate-syntax.mjs': `import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

const diagnostics = [];
for (const file of await walk('src')) {
  const source = await readFile(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  for (const diagnostic of result.diagnostics || []) {
    diagnostics.push(file + ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  }
}
if (diagnostics.length) {
  console.error('TypeScript syntax validation failed:\\n' + diagnostics.join('\\n'));
  process.exit(1);
}
console.log('TypeScript syntax validation passed.');`,
};

export function cloneStarterFiles(): FileMap {
  return { ...STARTER_FILES };
}

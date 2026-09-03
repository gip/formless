import {
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

  // Typed queries: these are the SVG nodes built by `getHighlightOverlay`, and
  // the bare `Element` querySelector returns has no `style`.
  const mask = overlay.querySelector<SVGMaskElement>('[data-agent-mask]');
  const backdrop = overlay.querySelector<SVGRectElement>('[data-agent-backdrop]');
  const outlines = overlay.querySelector<SVGGElement>('[data-agent-outlines]');
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
export const AgentLink = withAgentTarget('a');
export const AgentSelect = withAgentTarget('select');
export const AgentTextarea = withAgentTarget('textarea');

export function sendUserMessage(text: string, source: 'typed' | 'speech') {
  const normalized = text.trim();
  if (normalized) post('user-message', { text: normalized, source });
}

/* ------------------------------------------------------------------ *
 * Host capabilities
 *
 * This app is the part an agent is allowed to rewrite, so it deliberately
 * holds no access token and no encryption key. Anything sensitive lives in
 * the host and is reached by asking for it here. The host decides what to
 * answer: a version published by someone else gets state, but is refused
 * `auth.*` and `record.*` outright.
 * ------------------------------------------------------------------ */

export interface RouteDescriptor {
  path: string;
  title: string;
  description: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

const pending = new Map<string, PendingRequest>();
let requestCounter = 0;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Sign-in waits on a human in a popup, so it cannot share the default budget. */
const AUTH_TIMEOUT_MS = 10 * 60_000;

export function hostRequest<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  requestCounter += 1;
  const id = 'req-' + requestCounter;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('The host did not answer ' + method + ' in time.'));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    post('host-request', { id, method, params: params ?? {} });
  });
}

/**
 * Tells the host which routes this app can render. `navigate_to_route` is built
 * from exactly this list, so a route the app does not declare is a route the
 * agent cannot ask for.
 */
export function declareRoutes(routes: RouteDescriptor[], capabilities: string[] = []) {
  post('manifest', { routes, capabilities });
}

type HostEventHandler = (payload: unknown) => void;
const hostEventHandlers = new Map<string, Set<HostEventHandler>>();

/** Subscribes to a host-pushed event. Returns an unsubscribe function. */
export function onHostEvent(event: string, handler: HostEventHandler): () => void {
  const handlers = hostEventHandlers.get(event) ?? new Set<HostEventHandler>();
  handlers.add(handler);
  hostEventHandlers.set(event, handlers);
  return () => { handlers.delete(handler); };
}

export interface AuthStatus {
  configured: boolean;
  /**
   * Which Epic client ids the host holds. Epic issues separate non-production and
   * production ids, so readiness is per *environment* — an organization is
   * connectable when the credential for its environment exists.
   *
   * Mirrors `AuthStatus` in `lib/host-capabilities.ts`; the two are hand-kept in
   * sync and TypeScript cannot see across `postMessage`.
   */
  credentials: { production: boolean; sandbox: boolean };
  connected: boolean;
  provider: string | null;
  record: 'empty' | 'locked' | 'unlocked';
}

/** One selectable organization, as the host describes it. */
export interface ProviderChoice {
  id: string;
  name: string;
  myChartName: string;
  sandbox: boolean;
}

export const hostState = {
  get: <T,>(key: string) => hostRequest<T | undefined>('state.get', { key }),
  set: (key: string, value: unknown) => hostRequest('state.set', { key, value }),
  delete: (key: string) => hostRequest('state.delete', { key }),
};

export const hostAuth = {
  status: () => hostRequest<AuthStatus>('auth.status'),
  /**
   * Every organization the user can pick — the curated few plus Epic's published
   * directory, ~480 in all.
   *
   * Fetched whole, once, rather than searched per keystroke: the payload is small
   * and `hostRequest` has no sequencing, so a search-as-you-type design could
   * paint a slow early response over a fast later one.
   */
  providers: () => hostRequest<ProviderChoice[]>('auth.providers'),
  connect: (providerId: string, includeAttachments = false) =>
    hostRequest<AuthStatus>('auth.connect', { providerId, includeAttachments }, AUTH_TIMEOUT_MS),
  disconnect: () => hostRequest<AuthStatus>('auth.disconnect'),
};

export const hostRecord = {
  get: <T,>() => hostRequest<T | undefined>('record.get'),
  unlock: () => hostRequest<AuthStatus>('record.unlock', undefined, AUTH_TIMEOUT_MS),
  lock: () => hostRequest<AuthStatus>('record.lock'),
  clear: () => hostRequest<AuthStatus>('record.clear'),
  download: () => hostRequest('record.download', undefined, 120_000),
};

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (hostOrigin !== '*' && event.origin !== hostOrigin) return;
  const data = event.data as { protocol?: string; type?: string; payload?: Record<string, unknown> };
  if (data?.protocol !== PROTOCOL) return;

  if (data.type === 'host-response') {
    const id = typeof data.payload?.id === 'string' ? data.payload.id : '';
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    window.clearTimeout(request.timer);
    if (data.payload?.ok === true) request.resolve(data.payload.value);
    else {
      const message = typeof data.payload?.error === 'string' ? data.payload.error : 'The host refused the request.';
      request.reject(new Error(message));
    }
    return;
  }

  if (data.type === 'host-event') {
    const name = typeof data.payload?.event === 'string' ? data.payload.event : '';
    for (const handler of hostEventHandlers.get(name) ?? []) {
      // One misbehaving subscriber must not stop the others from being told.
      try { handler(data.payload?.payload); } catch { /* ignore */ }
    }
    return;
  }

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
});

import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';

import { AgentLink, onHostEvent, type RouteDescriptor } from '../agent/bridge';

/**
 * A hash router in about forty lines, because the guest may not add a
 * dependency: `guest/package.json` is protected, and changing it invalidates the
 * prebuilt WebContainer runtime in `public/guest-runtime/`.
 *
 * Hash rather than pushState is a correctness choice, not a shortcut. The bridge
 * pins its host origin from `?canvasHost=` on `window.location.search`, so a
 * path router that dropped the query string on reload would silently sever the
 * app from the host. A fragment cannot touch the query.
 */

export const ROUTES: RouteDescriptor[] = [
  {
    path: '/',
    title: 'Home',
    description: 'Landing page explaining the patient-authorized export, with the connect control.',
  },
  {
    path: '/explore',
    title: 'Explore your record',
    description: 'Browse the imported health record by resource type, rendered or as raw FHIR JSON.',
  },
];

const KNOWN = new Set(ROUTES.map((route) => route.path));

function readRoute(): string {
  const raw = window.location.hash.replace(/^#/, '');
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return KNOWN.has(path) ? path : '/';
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', notify);
}

export function navigate(path: string): void {
  if (!KNOWN.has(path)) return;
  const next = `#${path}`;
  if (window.location.hash === next) return;
  window.location.hash = next;
  // Safari fires hashchange asynchronously; nudging listeners keeps the first
  // render after a programmatic navigation in step with the URL.
  notify();
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, readRoute, () => '/');
}

/**
 * Lets `navigate_to_route` move the app. This is the reason the router exists
 * as a declared capability rather than internal state: an agent can take a user
 * to the record explorer without having to find and click a link, which is the
 * whole point for someone driving the page by voice.
 */
export function useHostNavigation(): void {
  useEffect(
    () =>
      onHostEvent('navigate', (payload) => {
        const path = (payload as { path?: unknown } | undefined)?.path;
        if (typeof path === 'string') navigate(path);
      }),
    [],
  );
}

/**
 * An in-app link. `AgentLink` wraps a real anchor, so this keeps middle-click,
 * copy-link, and the accessible role that a click-handling div would throw away.
 */
export function RouteLink({
  to,
  agentId,
  agentLabel,
  agentDescription,
  className,
  children,
}: {
  to: string;
  agentId: string;
  agentLabel: string;
  agentDescription?: string;
  className?: string;
  children: ReactNode;
}) {
  const route = useRoute();
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Leave modified clicks to the browser.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate(to);
    },
    [to],
  );

  return (
    <AgentLink
      agentId={agentId}
      agentLabel={agentLabel}
      agentDescription={agentDescription}
      className={className}
      href={`#${to}`}
      aria-current={route === to ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
    </AgentLink>
  );
}

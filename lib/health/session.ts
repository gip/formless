'use client';

import { buildAuthorizationUrl, discoverSmart } from './epic';
import { providerScope } from './providers';
import { resolveProvider } from './registry';

/**
 * The OAuth round trip, run from the host origin.
 *
 * Why a popup at all: the host page sets `Cross-Origin-Opener-Policy: same-origin`
 * because `WebContainer.boot({ coep: 'require-corp' })` requires it. That severs
 * `window.opener` the moment a popup navigates cross-origin to Epic, and coming
 * back to our own origin does not restore it — so the classic
 * popup-postMessage-to-opener pattern cannot return a result here.
 *
 * `BroadcastChannel` is origin-scoped and indifferent to browsing-context groups,
 * so the callback page broadcasts instead. Two consequences fall out and are
 * handled below:
 *   - the popup is opened at a *same-origin* URL first, which then redirects
 *     itself to Epic; opening straight to a cross-origin URL is what triggers
 *     severance at open time and can return a null handle immediately.
 *   - the host cannot poll `popup.closed` after the hop, so a user who abandons
 *     the flow is caught by the timeout and the caller's cancel, not by polling.
 *
 * Known limitation, accepted deliberately: `macos/` implements no
 * `createWebViewWith`, so `window.open` does nothing there. That is detected
 * below and surfaced as a clear message rather than an indefinite hang.
 */

/** Matches yesyouhealth's EPIC_SCOPE default; a provider may override it. */
export const DEFAULT_SCOPE = 'openid fhirUser launch/patient patient/*.rs';

export const AUTH_CHANNEL = 'webally-health-auth';
export const OAUTH_TRANSACTION_KEY = 'webally-oauth-transaction';

/** How long to wait for the popup to prove it opened before calling it blocked. */
const HEARTBEAT_TIMEOUT_MS = 2_500;
/** How long to wait for the user to finish signing in. */
const COMPLETION_TIMEOUT_MS = 10 * 60_000;

export interface OAuthTransaction {
  state: string;
  verifier: string;
  providerId: string;
  redirectUri: string;
  fhirBase: string;
  tokenEndpoint: string;
  clientId: string;
  createdAt: number;
}

export interface AuthResult {
  accessToken: string;
  patientId: string;
  providerId: string;
  fhirBase: string;
}

type ChannelMessage =
  | { kind: 'started' }
  | { kind: 'success'; result: AuthResult }
  | { kind: 'error'; message: string };

function randomString(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function redirectUri(): string {
  return new URL('/health/callback', window.location.origin).toString();
}

export class PopupBlockedError extends Error {}

/**
 * Runs the authorization step and resolves with a token once the callback page
 * broadcasts. Rejects on timeout, on an error from the callback, or when the
 * browser will not open a popup at all.
 */
export async function authorize(
  providerId: string,
  clientId: string,
  scope?: string,
): Promise<AuthResult> {
  const provider = await resolveProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const smart = await discoverSmart(provider.fhirBase);
  const state = randomString(16);
  const verifier = randomString(32);
  const transaction: OAuthTransaction = {
    state,
    verifier,
    providerId,
    redirectUri: redirectUri(),
    fhirBase: provider.fhirBase,
    tokenEndpoint: smart.token_endpoint,
    clientId,
    createdAt: Date.now(),
  };
  // sessionStorage, not a URL parameter: the verifier must not travel to Epic,
  // and the callback page runs same-origin so it can read it back.
  sessionStorage.setItem(OAUTH_TRANSACTION_KEY, JSON.stringify(transaction));

  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: smart.authorization_endpoint,
    clientId,
    redirectUri: transaction.redirectUri,
    scope: providerScope(provider, scope ?? DEFAULT_SCOPE),
    fhirBase: provider.fhirBase,
    state,
    challenge: await pkceChallenge(verifier),
  });

  // Open same-origin first. A cross-origin target here is what gets the handle
  // severed (and, under COOP, can come back null) before the flow even starts.
  const launcher = new URL('/health/connect', window.location.origin);
  launcher.searchParams.set('to', authorizationUrl);
  const popup = window.open(launcher.toString(), 'webally-health-auth', 'width=520,height=720');

  if (!popup) {
    sessionStorage.removeItem(OAUTH_TRANSACTION_KEY);
    throw new PopupBlockedError(
      'This browser would not open the sign-in window. Allow pop-ups for this site and try again.',
    );
  }

  return new Promise<AuthResult>((resolve, reject) => {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    // A holder rather than two `let`s: `finish` has to close over the timers,
    // but the timer callbacks call `finish`, so neither can be declared last.
    const timers: { heartbeat?: number; completion?: number } = {};

    function finish(settle: () => void) {
      window.clearTimeout(timers.heartbeat);
      window.clearTimeout(timers.completion);
      channel.close();
      sessionStorage.removeItem(OAUTH_TRANSACTION_KEY);
      settle();
    }

    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.kind === 'started') {
        // Proof the popup is alive; from here the user's own pace governs.
        window.clearTimeout(timers.heartbeat);
        return;
      }
      if (message.kind === 'success') finish(() => resolve(message.result));
      if (message.kind === 'error') finish(() => reject(new Error(message.message)));
    };

    timers.heartbeat = window.setTimeout(() => {
      finish(() =>
        reject(
          new PopupBlockedError(
            'The sign-in window did not open. This browser may not support pop-ups.',
          ),
        ),
      );
    }, HEARTBEAT_TIMEOUT_MS);

    timers.completion = window.setTimeout(() => {
      finish(() => reject(new Error('Sign-in timed out.')));
    }, COMPLETION_TIMEOUT_MS);
  });
}

export function readTransaction(): OAuthTransaction | undefined {
  try {
    const raw = sessionStorage.getItem(OAUTH_TRANSACTION_KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const transaction = value as Record<string, unknown>;
    if (typeof transaction.state !== 'string' || typeof transaction.verifier !== 'string') {
      return undefined;
    }
    return transaction as unknown as OAuthTransaction;
  } catch {
    return undefined;
  }
}

export function broadcast(message: ChannelMessage): void {
  try {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // Without BroadcastChannel the opener simply times out and says so.
  }
}

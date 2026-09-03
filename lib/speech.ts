'use client';

import type { SpeakRequest, SpeakResult, SpeechState, SpeechVoiceDescriptor } from './canvas-types';

/** Long enough for a paragraph, short enough that the wait below stays bounded. */
const MAX_TEXT = 2000;
/** `speak()` resolves at this point even if the utterance is still going. */
const MAX_WAIT_MS = 60_000;
/**
 * Chrome's synthesis watchdog truncates utterances past roughly fifteen
 * seconds. A periodic `resume()` while speech is in flight is the standard
 * workaround; it is a no-op on engines that do not need it.
 */
const RESUME_INTERVAL_MS = 10_000;

const NOT_ALLOWED =
  'The browser refused to speak because the page has no user activation. Ask the user to click anywhere on the Formless Labs page, outside the preview, then call speak_text again.';
const UNSUPPORTED = 'This browser does not provide the Web Speech synthesis API, so the page cannot speak.';

/** The slice of `SpeechSynthesisVoice` this module uses. */
interface VoiceLike {
  name: string;
  lang: string;
  default: boolean;
}

/** The slice of `SpeechSynthesisUtterance` this module sets. */
export interface UtteranceLike {
  text: string;
  voice: VoiceLike | null;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

/**
 * The slice of `SpeechSynthesis` this module uses. Structural rather than the
 * DOM type so `tests/speech.test.ts` can drive a plain object under the node
 * environment.
 */
export interface SynthLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  resume(): void;
  getVoices(): VoiceLike[];
  readonly speaking?: boolean;
  addEventListener?(type: 'voiceschanged', listener: () => void): void;
  removeEventListener?(type: 'voiceschanged', listener: () => void): void;
}

export interface SpeechPort {
  /** Resolves when the utterance ends, is interrupted, or the wait cap elapses. */
  speak(request: SpeakRequest): Promise<SpeakResult>;
  stop(): { cancelled: boolean };
  /** Must be called from a real user gesture; primes engines that gate on activation. */
  arm(): void;
  voices(): SpeechVoiceDescriptor[];
  getState(): SpeechState;
  subscribe(listener: () => void): () => void;
}

function numberIn(field: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function defaultUtterance(text: string): UtteranceLike {
  return new SpeechSynthesisUtterance(text) as unknown as UtteranceLike;
}

/**
 * Owns `window.speechSynthesis` for the host page. Both arguments are injected
 * so the port can be tested without a DOM: with neither a synthesizer nor an
 * utterance factory the port reports `supported: false` and fails cleanly
 * instead of throwing on an undefined global.
 */
export function createSpeechPort(
  synth: SynthLike | null = typeof globalThis.speechSynthesis === 'undefined'
    ? null
    : (globalThis.speechSynthesis as unknown as SynthLike),
  makeUtterance: (text: string) => UtteranceLike = defaultUtterance,
): SpeechPort {
  const listeners = new Set<() => void>();
  let state: SpeechState = {
    supported: synth !== null,
    armed: false,
    speaking: false,
    blocked: false,
    lastError: null,
  };

  function update(patch: Partial<SpeechState>): void {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  // `getVoices()` is read live rather than cached: it is cheap, and a cache
  // would only add a way to go stale. The listener exists so the header can
  // re-render once the engine finishes populating the list.
  const onVoicesChanged = () => listeners.forEach((listener) => listener());
  synth?.addEventListener?.('voiceschanged', onVoicesChanged);
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', () => synth?.cancel());
  }

  function voiceList(): VoiceLike[] {
    try {
      return synth?.getVoices() ?? [];
    } catch {
      return [];
    }
  }

  /** Exact name, then case-insensitive name, then language. Never a silent substitution. */
  function resolveVoice(name: string | undefined, lang: string | undefined): VoiceLike | null {
    const available = voiceList();
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('voice must be a non-empty string.');
      const match =
        available.find((entry) => entry.name === name) ??
        available.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (!match) {
        const known = available.slice(0, 5).map((entry) => entry.name).join(', ');
        throw new Error(`Unknown voice "${name}".${known ? ` Available voices include: ${known}.` : ' This browser reports no voices.'}`);
      }
      return match;
    }
    if (lang !== undefined) {
      if (typeof lang !== 'string' || !lang.trim()) throw new Error('lang must be a non-empty string.');
      const tag = lang.toLowerCase().replace(/_/g, '-');
      const base = tag.split('-')[0];
      return (
        available.find((entry) => entry.lang.toLowerCase().replace(/_/g, '-') === tag) ??
        available.find((entry) => entry.lang.toLowerCase().replace(/_/g, '-').startsWith(base)) ??
        null
      );
    }
    return null;
  }

  return {
    voices(): SpeechVoiceDescriptor[] {
      return voiceList()
        .map((entry) => ({ name: entry.name, lang: entry.lang, default: Boolean(entry.default) }))
        .sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
    },

    getState: () => state,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    arm(): void {
      if (!synth) return;
      try {
        const primer = makeUtterance(' ');
        primer.volume = 0;
        primer.onerror = (event) => {
          if (event?.error === 'not-allowed') update({ armed: false, blocked: true, lastError: NOT_ALLOWED });
        };
        synth.speak(primer);
        update({ armed: true, blocked: false, lastError: null });
      } catch (error) {
        update({ lastError: error instanceof Error ? error.message : 'Voice could not be enabled.' });
      }
    },

    stop(): { cancelled: boolean } {
      if (!synth) return { cancelled: false };
      const wasSpeaking = state.speaking || Boolean(synth.speaking);
      synth.cancel();
      update({ speaking: false });
      return { cancelled: wasSpeaking };
    },

    // `async` so that every failure — validation included — reaches the caller
    // as a rejection rather than a synchronous throw. The body still runs to
    // `synth.speak()` synchronously, so the utterance is queued immediately.
    async speak(request: SpeakRequest): Promise<SpeakResult> {
      if (!synth) throw new Error(UNSUPPORTED);
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (!text) throw new Error('text is required.');
      if (text.length > MAX_TEXT) {
        throw new Error(`text must be ${MAX_TEXT} characters or fewer; received ${text.length}.`);
      }
      const rate = numberIn('rate', request.rate, 0.5, 2, 1);
      const pitch = numberIn('pitch', request.pitch, 0, 2, 1);
      const volume = numberIn('volume', request.volume, 0, 1, 1);
      const chosen = resolveVoice(request.voice, request.lang);

      if (request.interrupt) synth.cancel();

      const utterance = makeUtterance(text);
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      if (chosen) utterance.voice = chosen;
      if (typeof request.lang === 'string' && request.lang.trim()) utterance.lang = request.lang;

      const startedAt = Date.now();
      return new Promise<SpeakResult>((resolve, reject) => {
        let answered = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let capTimer: ReturnType<typeof setTimeout> | null = null;

        const stopTimers = () => {
          if (heartbeat) clearInterval(heartbeat);
          if (capTimer) clearTimeout(capTimer);
          heartbeat = null;
          capTimer = null;
        };
        const answer = (settle: () => void) => {
          if (answered) return;
          answered = true;
          settle();
        };
        const result = (patch: Partial<SpeakResult>): SpeakResult => ({
          spoken: text,
          voice: chosen?.name ?? null,
          durationMs: Date.now() - startedAt,
          interrupted: false,
          stillSpeaking: false,
          ...patch,
        });

        utterance.onend = () => {
          stopTimers();
          update({ speaking: false });
          answer(() => resolve(result({})));
        };
        utterance.onerror = (event) => {
          const code = typeof event?.error === 'string' ? event.error : 'unknown';
          stopTimers();
          // `stop_speaking` and a later `interrupt: true` both land here. That
          // is the caller getting what they asked for, not a failure.
          if (code === 'interrupted' || code === 'canceled') {
            update({ speaking: false });
            answer(() => resolve(result({ interrupted: true })));
            return;
          }
          const message = code === 'not-allowed' ? NOT_ALLOWED : `Speech failed: ${code}.`;
          update({ speaking: false, blocked: code === 'not-allowed', lastError: message });
          answer(() => reject(new Error(message)));
        };

        // Past the cap the utterance is left running and the heartbeat with it;
        // `onend` still cleans up, it just no longer resolves anything.
        capTimer = setTimeout(() => answer(() => resolve(result({ stillSpeaking: true }))), MAX_WAIT_MS);
        heartbeat = setInterval(() => {
          try { synth.resume(); } catch { /* Engines without a watchdog need nothing. */ }
        }, RESUME_INTERVAL_MS);

        update({ speaking: true, blocked: false, lastError: null });
        synth.speak(utterance);
      });
    },
  };
}

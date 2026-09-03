import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpeechPort, type SynthLike, type UtteranceLike } from '../lib/speech';

/**
 * The tests are node-environment, so there is no `speechSynthesis` and no
 * `SpeechSynthesisUtterance`. Both are injected instead; this fake records what
 * was spoken and lets each test end the utterance however it wants to.
 */
function fakeSynth(voices: { name: string; lang: string; default: boolean }[] = []) {
  const spoken: UtteranceLike[] = [];
  const synth: SynthLike & { spoken: UtteranceLike[]; cancelled: number; resumed: number } = {
    spoken,
    cancelled: 0,
    resumed: 0,
    speaking: false,
    speak: (utterance) => { spoken.push(utterance); },
    cancel() { this.cancelled += 1; },
    resume() { this.resumed += 1; },
    getVoices: () => voices,
  };
  const makeUtterance = (text: string): UtteranceLike => ({
    text,
    voice: null,
    lang: '',
    rate: 1,
    pitch: 1,
    volume: 1,
    onend: null,
    onerror: null,
  });
  return { synth, makeUtterance, spoken };
}

const VOICES = [
  { name: 'Samantha', lang: 'en-US', default: true },
  { name: 'Daniel', lang: 'en-GB', default: false },
  { name: 'Amélie', lang: 'fr-CA', default: false },
];

afterEach(() => { vi.useRealTimers(); });

describe('speech port', () => {
  it('reports itself unsupported and fails cleanly with no synthesizer', async () => {
    const port = createSpeechPort(null);
    expect(port.getState().supported).toBe(false);
    expect(port.voices()).toEqual([]);
    expect(port.stop()).toEqual({ cancelled: false });
    await expect(port.speak({ text: 'hello' })).rejects.toThrow(/does not provide the Web Speech/);
  });

  it('resolves when the utterance ends, and tracks speaking state throughout', async () => {
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);
    const changes: boolean[] = [];
    port.subscribe(() => changes.push(port.getState().speaking));

    const pending = port.speak({ text: '  Your record is ready.  ', rate: 1.2, volume: 0.8 });
    expect(port.getState().speaking).toBe(true);
    expect(spoken[0].text).toBe('Your record is ready.');
    expect(spoken[0].rate).toBe(1.2);
    expect(spoken[0].volume).toBe(0.8);

    spoken[0].onend?.();
    await expect(pending).resolves.toMatchObject({
      spoken: 'Your record is ready.',
      voice: null,
      interrupted: false,
      stillSpeaking: false,
    });
    expect(port.getState().speaking).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('picks a voice by exact name, then by language, and refuses an unknown one', async () => {
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);

    const byName = port.speak({ text: 'hello', voice: 'Daniel' });
    expect(spoken[0].voice?.name).toBe('Daniel');
    spoken[0].onend?.();
    await expect(byName).resolves.toMatchObject({ voice: 'Daniel' });

    // A bare language tag matches the first voice in that language family.
    const byLang = port.speak({ text: 'bonjour', lang: 'fr' });
    expect(spoken[1].voice?.name).toBe('Amélie');
    expect(spoken[1].lang).toBe('fr');
    spoken[1].onend?.();
    await byLang;

    await expect(port.speak({ text: 'hello', voice: 'Zaphod' })).rejects.toThrow(
      'Unknown voice "Zaphod". Available voices include: Samantha, Daniel, Amélie.',
    );
    // Voices are listed default-first so the agent can see the platform pick.
    expect(port.voices()[0]).toEqual({ name: 'Samantha', lang: 'en-US', default: true });
  });

  it('rejects out-of-range options and over-long text before speaking', async () => {
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);
    await expect(port.speak({ text: '' })).rejects.toThrow(/text is required/);
    await expect(port.speak({ text: 'x'.repeat(2001) })).rejects.toThrow(/2000 characters or fewer/);
    await expect(port.speak({ text: 'hi', rate: 9 })).rejects.toThrow(/rate must be a number between 0.5 and 2/);
    await expect(port.speak({ text: 'hi', volume: -1 })).rejects.toThrow(/volume must be/);
    expect(spoken).toHaveLength(0);
  });

  it('treats an interruption as success and a real error as a failure', async () => {
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);

    const cut = port.speak({ text: 'a long explanation', interrupt: true });
    expect(synth.cancelled).toBe(1);
    spoken[0].onerror?.({ error: 'interrupted' });
    await expect(cut).resolves.toMatchObject({ interrupted: true, stillSpeaking: false });
    expect(port.getState().lastError).toBeNull();

    const broken = port.speak({ text: 'hello' });
    spoken[1].onerror?.({ error: 'synthesis-failed' });
    await expect(broken).rejects.toThrow(/Speech failed: synthesis-failed/);
    expect(port.getState()).toMatchObject({ speaking: false, blocked: false });
  });

  it('maps a blocked utterance to an actionable error and flags the header', async () => {
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);
    const pending = port.speak({ text: 'hello' });
    spoken[0].onerror?.({ error: 'not-allowed' });
    await expect(pending).rejects.toThrow(/Enable voice/);
    expect(port.getState()).toMatchObject({ blocked: true, speaking: false });

    // Arming primes the engine silently and clears the blocked flag.
    port.arm();
    expect(spoken[1]).toMatchObject({ text: ' ', volume: 0 });
    expect(port.getState()).toMatchObject({ armed: true, blocked: false, lastError: null });
    // …unless the primer is itself refused.
    spoken[1].onerror?.({ error: 'not-allowed' });
    expect(port.getState()).toMatchObject({ armed: false, blocked: true });
  });

  it('holds a resume heartbeat and resolves stillSpeaking at the wait cap', async () => {
    vi.useFakeTimers();
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);
    const pending = port.speak({ text: 'a very long passage' });

    // Chrome truncates long utterances without this.
    vi.advanceTimersByTime(25_000);
    expect(synth.resumed).toBe(2);

    vi.advanceTimersByTime(40_000);
    await expect(pending).resolves.toMatchObject({ stillSpeaking: true, interrupted: false });
    // The utterance was left running, so the page is still speaking.
    expect(port.getState().speaking).toBe(true);

    spoken[0].onend?.();
    expect(port.getState().speaking).toBe(false);
  });

  it('cancels in-flight speech on stop', async () => {
    const { synth, makeUtterance, spoken } = fakeSynth(VOICES);
    const port = createSpeechPort(synth, makeUtterance);
    const pending = port.speak({ text: 'hello' });
    expect(port.stop()).toEqual({ cancelled: true });
    expect(synth.cancelled).toBe(1);
    spoken[0].onerror?.({ error: 'canceled' });
    await expect(pending).resolves.toMatchObject({ interrupted: true });
    expect(port.stop()).toEqual({ cancelled: false });
  });
});

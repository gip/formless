'use client';

/**
 * The host page's voice control. It exists because Chrome refuses
 * `speechSynthesis.speak()` on a document with no user activation, and this
 * document rarely gets one — the user's clicks land inside the cross-origin
 * preview iframe, which does not count. One click here arms the synthesizer;
 * after that the same control reports what is being said and stops it.
 *
 * Presentational only, like `VersionSwitcher`: `CanvasApp` owns the state.
 */
export default function VoicePill({
  supported,
  armed,
  speaking,
  blocked,
  onArm,
  onStop,
}: {
  supported: boolean;
  armed: boolean;
  speaking: boolean;
  blocked: boolean;
  onArm: () => void;
  onStop: () => void;
}) {
  if (!supported) return null;

  const label = speaking ? 'Speaking… Stop' : blocked || !armed ? 'Enable voice' : 'Voice on';
  const title = blocked
    ? 'The browser blocked speech because the page had no user activation. Click to enable it.'
    : speaking
      ? 'Stop what the page is saying.'
      : armed
        ? 'The page can speak. Click to re-enable it if it goes quiet.'
        : 'Let the page speak out loud.';

  return (
    <button
      type="button"
      className={`voice-pill${speaking ? ' speaking' : ''}${blocked ? ' blocked' : ''}${armed && !blocked ? ' armed' : ''}`}
      onClick={speaking ? onStop : onArm}
      title={title}
      aria-live="polite"
    >
      <span aria-hidden="true" /> {label}
    </button>
  );
}

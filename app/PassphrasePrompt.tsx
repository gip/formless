'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Asks for the storage passphrase in host chrome, never in the preview.
 *
 * The guest app is the surface an agent is allowed to rewrite, and a published
 * version is a stranger's code. A passphrase field rendered there would be a
 * passphrase field an attacker controls, so the prompt lives out here and only
 * the derived key's *effects* cross the bridge.
 */

export const MIN_PASSPHRASE_LENGTH = 12;

export default function PassphrasePrompt({
  mode,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'unlock';
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (value.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (mode === 'create' && value !== confirmation) {
      setError('The two passphrases do not match.');
      return;
    }
    onSubmit(value);
  }

  return (
    <dialog
      className="passphrase-dialog"
      ref={dialogRef}
      aria-labelledby="passphrase-title"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <form onSubmit={submit}>
        <h2 id="passphrase-title">
          {mode === 'create' ? 'Choose a storage passphrase' : 'Unlock your health record'}
        </h2>
        <p>
          {mode === 'create'
            ? 'Your record is encrypted in this browser with a key derived from this passphrase. It is never sent anywhere, and it cannot be recovered — if you lose it, the record is unreadable.'
            : 'The key exists only in memory. Enter your passphrase to derive it again.'}
        </p>

        <label htmlFor="passphrase-value">Passphrase</label>
        <input
          id="passphrase-value"
          type="password"
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          value={value}
          onChange={(event) => { setValue(event.currentTarget.value); setError(undefined); }}
          autoFocus
        />

        {mode === 'create' ? (
          <>
            <label htmlFor="passphrase-confirm">Confirm passphrase</label>
            <input
              id="passphrase-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => { setConfirmation(event.currentTarget.value); setError(undefined); }}
            />
          </>
        ) : null}

        {error ? <p className="passphrase-error" role="alert">{error}</p> : null}

        <div className="passphrase-actions">
          <button type="button" className="passphrase-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="passphrase-primary">
            {mode === 'create' ? 'Encrypt and continue' : 'Unlock'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

'use client';

import { useEffect, useRef } from 'react';

import type { AppVersion } from '@/lib/canvas-types';

/**
 * Explains, in host chrome, why a version somebody else published is running
 * without access to the health record — and offers to lift that.
 *
 * Rendered by the host and never by the guest, for the same reason
 * `PassphrasePrompt` is: the preview is the surface a stranger's code owns, so a
 * security warning drawn inside it is a security warning that code could style
 * away, reword, or click for you.
 *
 * The safe action is the default and the bypass is the small-print one, matching
 * the passphrase prompt's shape. Nothing here happens implicitly: dismissing
 * leaves the version exactly as it loaded, sandboxed.
 */
export default function VersionTrustPrompt({
  version,
  onKeepSandboxed,
  onTrust,
}: {
  version: AppVersion;
  onKeepSandboxed: () => void;
  onTrust: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return (
    <dialog
      className="trust-dialog"
      ref={dialogRef}
      aria-labelledby="trust-title"
      onCancel={(event) => { event.preventDefault(); onKeepSandboxed(); }}
    >
      <div className="trust-body">
        <h2 id="trust-title">“{version.name}” was published by someone else</h2>
        <p>
          This version was written by <strong>{version.authorLabel}</strong>, not by you, and
          nobody has reviewed it. It is running sandboxed: it can draw the page and keep its own
          scratch state, but it cannot reach your health record, your MyChart connection, or the
          microphone. That is why its connect button is greyed out.
        </p>
        <p>
          Running it as it is costs you nothing. Giving it access is the part that is not advised —
          code you have not read would be able to ask for your record and act on your MyChart
          connection.
        </p>

        <div className="trust-actions">
          <button type="button" className="trust-primary" onClick={onKeepSandboxed} autoFocus>
            Keep it sandboxed
          </button>
        </div>

        <div className="trust-bypass">
          <button type="button" className="trust-bypass-button" onClick={onTrust}>
            I trust this version — give it access
          </button>
          <p>
            Only if you know who {version.authorLabel} is, or you have read the code yourself. This
            choice is remembered for this exact version in this browser, and it grants the same
            access to your health record that an app you published yourself would have.
          </p>
        </div>
      </div>
    </dialog>
  );
}

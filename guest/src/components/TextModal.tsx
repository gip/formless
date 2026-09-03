import { useEffect, useRef } from 'react';

import { AgentButton, AgentTarget } from '../agent/bridge';

/**
 * Full text of an attachment, ported from the `TextModal` inside
 * yesyouhealth's `app/explore/explore-client.tsx`.
 */

export type AttachmentTextView = 'plain' | 'raw';

export interface TextPreview {
  content: string;
  contentType: string;
  view: AttachmentTextView;
  title: string;
}

/** Strips markup so a clinical note reads as prose rather than as HTML source. */
export function htmlToPlainText(content: string): string {
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  parsed.querySelectorAll('script, style, template, noscript').forEach((element) => {
    element.remove();
  });
  parsed.querySelectorAll('br').forEach((element) => {
    element.replaceWith('\n');
  });
  parsed
    .querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article')
    .forEach((element) => {
      element.append('\n');
    });
  return (parsed.body.textContent ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Decodes a FHIR `Binary.data` payload. `atob` yields latin1, so the bytes go
 * back through `TextDecoder` — a UTF-8 note otherwise arrives mojibaked.
 */
export function decodeBase64Text(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const binary = atob(value.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

export default function TextModal({
  preview,
  onClose,
}: {
  preview: TextPreview;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      aria-labelledby="file-text-title"
      className="raw-text-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="raw-text-dialog-header">
        <div>
          <p className="resource-kicker">
            {preview.view === 'raw' ? 'Raw file text' : 'Note text'}
          </p>
          <h2 id="file-text-title">{preview.title}</h2>
          <p>
            {preview.contentType} ·{' '}
            {preview.view === 'raw'
              ? 'Decoded as UTF-8. Binary formats may include characters that are not human-readable.'
              : 'HTML tags and non-content elements have been removed for readability.'}
          </p>
        </div>
        <AgentButton
          agentId="close-text-modal"
          agentLabel="Close the file text"
          agentDescription="Closes the attachment text dialog."
          aria-label={preview.view === 'raw' ? 'Close raw text' : 'Close note text'}
          className="raw-text-dialog-close"
          type="button"
          onClick={onClose}
        >
          ×
        </AgentButton>
      </div>
      <AgentTarget
        agentId="attachment-text"
        label="Attachment text"
        description="The full text of the selected file."
      >
        <pre className="raw-text-content"><code>{preview.content}</code></pre>
      </AgentTarget>
      <div className="raw-text-dialog-footer">
        <AgentButton
          agentId="close-text-modal-footer"
          agentLabel="Close"
          agentDescription="Closes the attachment text dialog."
          className="button secondary"
          type="button"
          onClick={onClose}
        >
          Close
        </AgentButton>
      </div>
    </dialog>
  );
}

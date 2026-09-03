import { useEffect, useRef, useState } from 'react';

import { AgentButton, AgentTarget, hostRequest, hostState } from '../agent/bridge';
import { TermsDocument } from './TermsView';
import {
  isTermsAcceptance,
  TERMS_EFFECTIVE,
  TERMS_HIGHLIGHTS,
  TERMS_STATE_KEY,
  TERMS_VERSION,
} from './terms';

/**
 * The acceptance gate: nobody reaches the record without having read what
 * happens to it.
 *
 * A modal `<dialog>` rather than a banner, because the two things being
 * consented to are not decorative — an AI agent attached to this page can read
 * personal health information and send it to OpenAI, and a clinician using this
 * site for work is doing something they must not do. Neither is a footnote.
 *
 * Acceptance is stored through `state.*`, which the host scopes per app version.
 * That gives the two re-prompts we want for free: a change to `TERMS_VERSION`
 * invalidates the stored answer, and a version published by someone else has its
 * own scope, so agreeing to the starter's terms never silently carries over into
 * a stranger's interface.
 */

/**
 * The host answers a state read within a frame or two. `hostState.get` would
 * wait the default thirty seconds before giving up, and a page that stays
 * ungated for thirty seconds outside the canvas is exactly the failure this
 * component exists to prevent — so this read gets its own short budget and
 * treats silence as "not accepted".
 */
const STATE_TIMEOUT_MS = 5_000;

type Stage = 'reading' | 'prompt' | 'declined' | 'settled';

export default function TermsGate() {
  const [stage, setStage] = useState<Stage>('reading');
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let cancelled = false;
    hostRequest<unknown>('state.get', { key: TERMS_STATE_KEY }, STATE_TIMEOUT_MS).then(
      (value) => {
        if (cancelled) return;
        const accepted = isTermsAcceptance(value) && value.version === TERMS_VERSION;
        setStage(accepted ? 'settled' : 'prompt');
      },
      () => { if (!cancelled) setStage('prompt'); },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [stage]);

  function accept() {
    setStage('settled');
    // A host that cannot store the answer is not a reason to hold the page
    // hostage. The whole cost of a failed write is being asked again next boot,
    // which is the safe direction to fail in.
    void hostState
      .set(TERMS_STATE_KEY, { version: TERMS_VERSION, acceptedAt: new Date().toISOString() })
      .catch(() => undefined);
  }

  if (stage === 'reading' || stage === 'settled') return null;

  return (
    <dialog
      aria-labelledby="terms-gate-title"
      className="terms-dialog"
      ref={dialogRef}
      // There is no dismissing this one. Escape has to mean something other than
      // "agreed", and the only two answers are the two buttons below.
      onCancel={(event) => { event.preventDefault(); }}
    >
      {stage === 'declined' ? (
        <div className="terms-dialog-declined">
          <h2 id="terms-gate-title">Formless Health needs your agreement.</h2>
          <p>
            Nothing has been connected and nothing has been shared. Close this tab to leave, or
            read the terms again if you want to reconsider.
          </p>
          <AgentButton
            agentId="terms-gate-reconsider"
            agentLabel="Read the terms again"
            agentDescription="Returns to the terms of service so the user can accept them."
            className="button secondary"
            type="button"
            onClick={() => setStage('prompt')}
          >
            Read the terms again
          </AgentButton>
        </div>
      ) : (
        <>
          <div className="terms-dialog-header">
            <p className="resource-kicker">Before you start</p>
            <h2 id="terms-gate-title">Agree to the terms of service</h2>
            <p className="terms-dialog-meta">
              Version {TERMS_VERSION} · Effective {TERMS_EFFECTIVE}
            </p>
          </div>

          <div className="terms-dialog-scroll">
            <AgentTarget
              agentId="terms-gate-highlights"
              label="What you are agreeing to"
              description="The four points of the terms of service a person must understand before using the site: personal use only, no health data on the server, health information can reach OpenAI while an agent is attached, and this is not medical advice."
            >
              <ul className="terms-points">
                {TERMS_HIGHLIGHTS.map((highlight) => (
                  <li key={highlight.title}>
                    <strong>{highlight.title}</strong>
                    <span>{highlight.body}</span>
                  </li>
                ))}
              </ul>
            </AgentTarget>

            <AgentButton
              agentId="terms-gate-toggle-full"
              agentLabel={expanded ? 'Hide the full terms' : 'Read the full terms'}
              agentDescription="Shows or hides the complete terms of service inside this dialog."
              className="text-button terms-dialog-toggle"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Hide the full terms' : 'Read the full terms'}
            </AgentButton>

            {expanded ? <TermsDocument idPrefix="terms-gate" /> : null}
          </div>

          <div className="terms-dialog-footer">
            <AgentButton
              agentId="terms-gate-decline"
              agentLabel="Do not agree"
              agentDescription="Declines the terms of service. The site stays unusable until they are accepted."
              className="button secondary"
              type="button"
              onClick={() => setStage('declined')}
            >
              I do not agree
            </AgentButton>
            <AgentButton
              agentId="terms-gate-accept"
              agentLabel="Agree and continue"
              agentDescription="Accepts the terms of service and unblocks the site."
              className="button primary"
              type="button"
              onClick={accept}
            >
              I agree — continue
            </AgentButton>
          </div>
        </>
      )}
    </dialog>
  );
}

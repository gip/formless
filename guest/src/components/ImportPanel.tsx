import { AgentTarget } from '../agent/bridge';
import { groupLabel } from './explore-data';
import type { ImportState } from './import-progress';

/**
 * What the record explorer shows while the host is still downloading.
 *
 * The app has no visibility into the import beyond the counts the host sends,
 * and deliberately so — the token and the FHIR requests are the host's. So this
 * is honest about what it knows: how many records have arrived, how far through
 * the search list the host is, and which resource type most recently produced
 * data. Nothing here is a prediction of how long it will take.
 */

function detailLine(state: ImportState): string {
  const progress = state.progress;
  if (!progress) return 'Asking your provider for the first records…';

  const parts = [`${progress.completedSearches} of ${progress.totalSearches} searches complete`];
  if (progress.label) parts.push(`latest ${groupLabel(progress.label).toLowerCase()}`);
  if (progress.attachmentCount > 0) {
    parts.push(`${progress.attachmentCount} clinical-note ${progress.attachmentCount === 1 ? 'file' : 'files'}`);
  }
  return parts.join(' · ');
}

export default function ImportPanel({ state }: { state: ImportState }) {
  const progress = state.progress;
  const fraction = progress && progress.totalSearches > 0
    ? Math.min(1, progress.completedSearches / progress.totalSearches)
    : undefined;

  return (
    <main className="explore-shell explore-empty">
      <section className="import-card">
        <p className="eyebrow">Importing your record</p>
        {/* The provider goes on its own line rather than into the heading: the
            names run from "UCSF Health" to "Sutter My Health Online", and a
            display-size heading that rewraps per provider looks like a bug. */}
        <h1>Downloading your record</h1>
        {state.providerName ? <p className="explore-meta">From {state.providerName}</p> : null}

        <AgentTarget
          agentId="import-progress"
          label="Import progress"
          description="How much of the health record has been downloaded so far."
        >
          {/* One live region for the whole block: announcing every count change
              separately would talk over a screen reader for the entire import. */}
          <div className="import-progress" role="status" aria-live="polite">
            {/* No count until there is one to show: a large "0" while the first
                request is still in flight reads as a failure, not as progress. */}
            {progress ? (
              <p className="import-count">
                <strong>{progress.resourceCount.toLocaleString()}</strong>
                <span>records so far</span>
              </p>
            ) : null}
            <div
              className={fraction === undefined ? 'import-bar waiting' : 'import-bar'}
              role="progressbar"
              aria-label="Records downloaded"
              {...(fraction === undefined
                ? {}
                : { 'aria-valuenow': Math.round(fraction * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 })}
            >
              <div
                className="import-bar-fill"
                style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }}
              />
            </div>
            <p className="import-detail">{detailLine(state)}</p>
          </div>
        </AgentTarget>

        <p className="import-note">
          Your record is downloading straight into this browser and is encrypted with the passphrase
          you just set. It opens here as soon as the download finishes.
        </p>
      </section>
    </main>
  );
}

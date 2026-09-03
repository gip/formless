import { useEffect, useMemo, useState } from 'react';

import {
  AgentButton,
  AgentInput,
  hostAuth,
  onHostEvent,
  type AuthStatus,
  type ProviderChoice,
} from '../agent/bridge';
import { DEFAULT_PROVIDER_ID, PROVIDER_OPTIONS } from './health-types';
import { RouteLink } from './router';

/**
 * The connect control, ported from yesyouhealth's `app/connect-button.tsx`.
 *
 * The original built a PKCE authorization URL here and did
 * `window.location.assign(...)` straight to Epic. That cannot work from this
 * app: the WebContainer preview gets an ephemeral origin on every boot, which
 * can never be a registered `redirect_uri`. So the whole flow moved to the host,
 * which has a stable origin — and, usefully, that also means the access token
 * never exists in code an agent is allowed to rewrite. All that is left here is
 * the choice of provider.
 *
 * That choice used to be a dropdown over three organizations. The host now
 * serves every organization in Epic's published directory — around 480 — so it
 * is a search box instead. Three consequences shape the code below.
 */

/** Enough matches to choose from; few enough to keep the agent registry small. */
const MAX_RESULTS = 8;

/**
 * The fallback list, shaped like the host's answer.
 *
 * The picker is usable from first paint and never blocks on a fetch: if the host
 * is slow, unreachable, or this is a version published by someone else (which
 * cannot call privileged methods at all), the panel offers exactly what it
 * offered before the directory existed.
 */
const FALLBACK_CHOICES: ProviderChoice[] = PROVIDER_OPTIONS.map((option) => ({
  id: option.id,
  name: option.label,
  myChartName: option.myChartName,
  sandbox: option.sandbox ?? false,
}));

function matches(choices: ProviderChoice[], query: string): ProviderChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return choices.slice(0, MAX_RESULTS);
  // Organizations whose name *starts* with the query first: someone typing
  // "sut" wants Sutter Health above "Kaiser Permanente – South Sutter".
  const starts: ProviderChoice[] = [];
  const contains: ProviderChoice[] = [];
  for (const choice of choices) {
    const name = choice.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(choice);
    else if (name.includes(needle)) contains.push(choice);
    if (starts.length >= MAX_RESULTS) break;
  }
  return [...starts, ...contains].slice(0, MAX_RESULTS);
}

export default function ConnectPanel() {
  const [status, setStatus] = useState<AuthStatus>();
  const [choices, setChoices] = useState<ProviderChoice[]>(FALLBACK_CHOICES);
  /**
   * The whole selected option, not just its id.
   *
   * With ~480 organizations arriving asynchronously there is nothing to
   * synchronously look an id up in, and the connect button's label and
   * aria-label both need the portal name during render.
   */
  const [selected, setSelected] = useState<ProviderChoice>(
    () => FALLBACK_CHOICES.find((choice) => choice.id === DEFAULT_PROVIDER_ID) ?? FALLBACK_CHOICES[0],
  );
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    hostAuth.status().then(
      (value) => { if (!cancelled) setStatus(value); },
      () => { if (!cancelled) setStatus(undefined); },
    );
    return () => { cancelled = true; };
  }, []);

  // One fetch for the whole directory rather than a request per keystroke.
  // `hostRequest` has no sequencing, so a search-as-you-type design could paint a
  // slow early response over a fast later one; filtering locally cannot race.
  // A failure is silent by design — `choices` simply stays as the fallback.
  useEffect(() => {
    let cancelled = false;
    hostAuth.providers().then(
      (value) => {
        if (cancelled || !Array.isArray(value) || value.length === 0) return;
        setChoices(value);
        // Adopt the host's richer entry for whatever is already selected.
        setSelected((current) => value.find((choice) => choice.id === current.id) ?? current);
      },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(
    () => onHostEvent('record.changed', () => {
      hostAuth.status().then(setStatus, () => undefined);
    }),
    [],
  );

  async function connect() {
    setConnecting(true);
    setError(undefined);
    try {
      setStatus(await hostAuth.connect(selected.id, includeAttachments));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the connection.');
    } finally {
      setConnecting(false);
    }
  }

  function choose(choice: ProviderChoice) {
    setSelected(choice);
    setSearching(false);
    setQuery('');
  }

  const results = useMemo(
    () => (searching ? matches(choices, query) : []),
    [searching, choices, query],
  );

  const connected = status?.connected ?? false;
  /**
   * Readiness is per *environment*, not per organization. Epic issues separate
   * non-production and production client ids, and every production organization
   * shares the production one — so this is the credential for the environment the
   * selected organization lives in.
   */
  const credentials = status?.credentials;
  const providerReady = selected.sandbox
    ? (credentials?.sandbox ?? false)
    : (credentials?.production ?? false);
  const anythingReady = status?.configured ?? false;

  if (connected) {
    return (
      <div className="actions">
        <RouteLink
          to="/explore"
          agentId="connect-view-record"
          agentLabel="View your record"
          agentDescription="Opens the record explorer for the record you imported."
          className="button primary"
        >
          View your record
        </RouteLink>
        <AgentButton
          agentId="connect-disconnect"
          agentLabel="Disconnect"
          agentDescription="Removes the imported record from this browser."
          type="button"
          className="button secondary"
          onClick={() => { void hostAuth.disconnect().then(setStatus, () => undefined); }}
        >
          Disconnect
        </AgentButton>
      </div>
    );
  }

  return (
    <div className="connect-panel">
      <div className="provider-picker">
        <label htmlFor="provider-search">Healthcare organization</label>
        <div className="provider-search">
          <AgentInput
            agentId="provider-search-control"
            agentLabel="Healthcare organization"
            agentDescription={`Search the ${choices.length} organizations that can share a record. Currently ${selected.name}.`}
            id="provider-search"
            type="text"
            role="combobox"
            aria-expanded={searching}
            aria-controls="provider-results"
            aria-autocomplete="list"
            autoComplete="off"
            placeholder={selected.name}
            value={searching ? query : selected.name}
            onFocus={(event) => { setSearching(true); setQuery(''); event.currentTarget.select(); }}
            // Selecting a result cancels mousedown to keep the click from being
            // eaten by blur, which leaves focus on the input — so clicking the
            // box again fires no `focus` event and the reset above never runs.
            // Selecting the text here means the next keystroke replaces the
            // organization name instead of being appended to it.
            onClick={(event) => { event.currentTarget.select(); }}
            // Results close on blur; each row cancels mousedown so the click
            // still lands rather than being eaten by this.
            onBlur={() => { setSearching(false); setQuery(''); }}
            onChange={(event) => { setSearching(true); setQuery(event.currentTarget.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setSearching(false); setQuery(''); }
              if (event.key === 'Enter' && results[0]) { event.preventDefault(); choose(results[0]); }
            }}
          />
          {searching && results.length > 0 ? (
            <ul className="provider-results" id="provider-results" role="listbox">
              {results.map((choice) => (
                <li key={choice.id} role="option" aria-selected={choice.id === selected.id}>
                  {/* One agent target per row, capped at MAX_RESULTS: every mount
                      republishes the whole registry to the host, so an uncapped
                      list would repost it on each keystroke. The id is derived,
                      so the audit's duplicate-literal check is unaffected and
                      organization ids are already unique. */}
                  <AgentButton
                    agentId={`provider-option-${choice.id}`}
                    agentLabel={choice.name}
                    agentDescription={`Selects ${choice.name} as the organization to sign in to.`}
                    type="button"
                    className="provider-result"
                    onMouseDown={(event) => { event.preventDefault(); }}
                    onClick={() => choose(choice)}
                  >
                    {choice.name}
                  </AgentButton>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {/* One live region for the picker: announcing each keystroke's result count
          separately would talk over a screen reader mid-word. */}
      <p className="sr-only" role="status" aria-live="polite">
        {searching ? `${results.length} of ${choices.length} organizations match` : ''}
      </p>

      <div className="attachment-option">
        <AgentInput
          agentId="include-attachments"
          agentLabel="Include clinical-note files"
          agentDescription="Whether to download clinical note attachments alongside the record."
          id="include-attachments-input"
          type="checkbox"
          checked={includeAttachments}
          onChange={(event) => setIncludeAttachments(event.currentTarget.checked)}
        />
        <label htmlFor="include-attachments-input">Include clinical-note files</label>
      </div>

      <div className="actions">
        <AgentButton
          agentId="connect-mychart"
          agentLabel={`Connect ${selected.myChartName}`}
          agentDescription="Starts the patient-authorized MyChart export. Opens a sign-in window."
          type="button"
          className="button primary"
          disabled={connecting || !providerReady}
          onClick={() => { void connect(); }}
        >
          {connecting ? 'Waiting for sign-in…' : `Connect ${selected.myChartName}`}
        </AgentButton>
        <RouteLink
          to="/explore"
          agentId="connect-see-sample"
          agentLabel="See a sample record"
          agentDescription="Opens the record explorer with a de-identified sample record."
          className="button secondary"
        >
          See a sample record
        </RouteLink>
      </div>

      {status && !anythingReady ? (
        <p className="sandbox-note">
          Connecting a real record is not configured in this deployment, so the explorer shows a
          de-identified sample instead.
        </p>
      ) : null}
      {status && anythingReady && !providerReady ? (
        <p className="sandbox-note">
          No client id is configured for {selected.sandbox ? 'Epic’s sandbox' : 'production organizations'}.
          Epic issues separate non-production and production client ids — set{' '}
          <code>{selected.sandbox ? 'NEXT_PUBLIC_EPIC_SANDBOX_CLIENT_ID' : 'NEXT_PUBLIC_EPIC_CLIENT_ID'}</code>,
          or pick an organization whose environment is configured.
        </p>
      ) : null}
      {selected.sandbox ? (
        <p className="sandbox-note">This is a test sandbox, not a real health system.</p>
      ) : null}
      {error ? <p className="error compact-error" role="alert">{error}</p> : null}
    </div>
  );
}

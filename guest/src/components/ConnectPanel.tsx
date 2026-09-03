import { useEffect, useState } from 'react';

import { AgentButton, AgentInput, AgentSelect, hostAuth, onHostEvent, type AuthStatus } from '../agent/bridge';
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
 */

export default function ConnectPanel() {
  const [status, setStatus] = useState<AuthStatus>();
  const [providerId, setProviderId] = useState(DEFAULT_PROVIDER_ID);
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

  useEffect(
    () => onHostEvent('record.changed', () => {
      hostAuth.status().then(setStatus, () => undefined);
    }),
    [],
  );

  useEffect(() => {
    const ready = status?.configuredProviders ?? [];
    if (!ready.length || ready.includes(providerId)) return;
    // Only when the current pick has no credential — never overrides the user.
    setProviderId(ready[0]);
  }, [status, providerId]);

  async function connect() {
    setConnecting(true);
    setError(undefined);
    try {
      setStatus(await hostAuth.connect(providerId, includeAttachments));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the connection.');
    } finally {
      setConnecting(false);
    }
  }

  const provider = PROVIDER_OPTIONS.find((option) => option.id === providerId) ?? PROVIDER_OPTIONS[0];
  const connected = status?.connected ?? false;
  // Configuration is per provider: Epic issues separate non-production and
  // production client ids, so having one says nothing about the other.
  const available = status?.configuredProviders ?? [];
  const providerReady = available.includes(providerId);
  const anythingReady = (status?.configured ?? false) && available.length > 0;

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
        <label htmlFor="provider-select">Healthcare organization</label>
        <AgentSelect
          agentId="provider-select-control"
          agentLabel="Healthcare organization"
          agentDescription="Chooses which MyChart organization to authorize with."
          id="provider-select"
          value={providerId}
          onChange={(event) => setProviderId(event.currentTarget.value)}
        >
          {PROVIDER_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </AgentSelect>
      </div>

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
          agentLabel={`Connect ${provider.myChartName}`}
          agentDescription="Starts the patient-authorized MyChart export. Opens a sign-in window."
          type="button"
          className="button primary"
          disabled={connecting || !providerReady}
          onClick={() => { void connect(); }}
        >
          {connecting ? 'Waiting for sign-in…' : `Connect ${provider.myChartName}`}
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
          No client id is configured for {provider.label}. Epic issues separate non-production and
          production client ids — set <code>VITE_EPIC_CLIENT_ID</code> for this organization, or pick
          a provider that is configured.
        </p>
      ) : null}
      {provider.sandbox ? (
        <p className="sandbox-note">This is a test sandbox, not a real health system.</p>
      ) : null}
      {error ? <p className="error compact-error" role="alert">{error}</p> : null}
    </div>
  );
}

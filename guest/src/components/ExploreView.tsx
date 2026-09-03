import { useEffect, useMemo, useState } from 'react';

import {
  AgentButton,
  AgentTarget,
  hostAuth,
  hostRecord,
  hostState,
  onHostEvent,
  type AuthStatus,
} from '../agent/bridge';
import {
  compactIdentifier,
  getResourceGroups,
  patientDisplayName,
  renderedFields,
  resourceTitle,
} from './explore-data';
import type { HealthExportDocument } from './health-types';
import { RouteLink } from './router';
import TextModal, { htmlToPlainText, type AttachmentTextView, type TextPreview } from './TextModal';

/**
 * The record explorer, ported from yesyouhealth's `app/explore/explore-client.tsx`.
 *
 * The original opened an encrypted IndexedDB store directly and held the
 * decryption key in the page. Here the record arrives already decrypted from the
 * host, because this file is exactly the surface an agent may rewrite. What is
 * left is presentation — which is all it ever really was.
 *
 * The passphrase prompt for the locked state also moved to host chrome; the
 * locked branch here just asks the host to run it.
 */

type DataView = 'rendered' | 'raw';

const VIEW_STATE_KEY = 'explore.view';

export default function ExploreView() {
  const [record, setRecord] = useState<HealthExportDocument>();
  const [status, setStatus] = useState<AuthStatus>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [resourceIndex, setResourceIndex] = useState(0);
  const [view, setView] = useState<DataView>('rendered');
  const [busy, setBusy] = useState<'download' | 'clear' | 'lock' | 'unlock'>();
  const [attachmentTextLoading, setAttachmentTextLoading] = useState<AttachmentTextView>();
  const [textPreview, setTextPreview] = useState<TextPreview>();

  async function refresh() {
    try {
      const [nextRecord, nextStatus] = await Promise.all([
        hostRecord.get<HealthExportDocument>(),
        hostAuth.status(),
      ]);
      setRecord(nextRecord);
      setStatus(nextStatus);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Could not open the record.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextRecord, nextStatus, storedView] = await Promise.all([
          hostRecord.get<HealthExportDocument>(),
          hostAuth.status(),
          hostState.get<DataView>(VIEW_STATE_KEY),
        ]);
        if (cancelled) return;
        setRecord(nextRecord);
        setStatus(nextStatus);
        if (storedView === 'rendered' || storedView === 'raw') setView(storedView);
      } catch (caught) {
        if (!cancelled) {
          setLoadError(caught instanceof Error ? caught.message : 'Could not open the record.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onHostEvent('record.changed', () => { void refresh(); }), []);

  const groups = useMemo(() => (record ? getResourceGroups(record) : []), [record]);
  const activeGroup = groups.find((group) => group.key === selectedKey) ?? groups[0];
  const activeResource = activeGroup?.resources[resourceIndex] ?? activeGroup?.resources[0];
  const fields = activeResource ? renderedFields(activeResource) : [];
  const errorEntries = record ? Object.entries(record.errors) : [];

  function chooseView(next: DataView) {
    setView(next);
    // Remembered host-side: the preview origin changes on every container boot,
    // so anything stored in the guest would be silently discarded.
    void hostState.set(VIEW_STATE_KEY, next).catch(() => undefined);
  }

  async function run(kind: 'download' | 'clear' | 'lock' | 'unlock') {
    setBusy(kind);
    setLoadError(undefined);
    try {
      if (kind === 'download') await hostRecord.download();
      if (kind === 'clear') setStatus(await hostRecord.clear());
      if (kind === 'lock') setStatus(await hostRecord.lock());
      if (kind === 'unlock') setStatus(await hostRecord.unlock());
      if (kind !== 'download') await refresh();
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setBusy(undefined);
    }
  }

  function selectGroup(key: string) {
    setSelectedKey(key);
    setResourceIndex(0);
  }

  async function viewAttachmentText(resource: Record<string, unknown>, textView: AttachmentTextView) {
    const key = typeof resource.key === 'string' ? resource.key : undefined;
    if (!key) {
      setLoadError('The stored file could not be identified.');
      return;
    }
    setAttachmentTextLoading(textView);
    setLoadError(undefined);
    try {
      // Attachment bodies are not part of the exported document, so the sample
      // record has none to open. The host owns fetching them when it has a real
      // import; until then this is an honest "not available" rather than a crash.
      const content = typeof resource.text === 'string' ? resource.text : '';
      if (!content) throw new Error('The text of this file is not available in this record.');
      setTextPreview({
        content: textView === 'plain' ? htmlToPlainText(content) : content,
        contentType: typeof resource.contentType === 'string' ? resource.contentType : 'text/plain',
        title: compactIdentifier(resource.id) ?? String(resource.id ?? 'File'),
        view: textView,
      });
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Could not open the file text.');
    } finally {
      setAttachmentTextLoading(undefined);
    }
  }

  if (loading) {
    return (
      <main className="explore-shell explore-empty">
        <div className="spinner" aria-hidden="true" />
        <p>Opening your record…</p>
      </main>
    );
  }

  if (status?.record === 'locked') {
    return (
      <main className="explore-shell explore-empty">
        <section className="unlock-card">
          <p className="eyebrow">Encrypted local record</p>
          <h1>Unlock your health record.</h1>
          <p>
            The encryption key exists only in memory. WebAlly will ask for your storage passphrase
            outside this page, so no code running here can read it.
          </p>
          <AgentButton
            agentId="explore-unlock"
            agentLabel="Unlock record"
            agentDescription="Asks the host to prompt for the storage passphrase and decrypt the record."
            className="button primary"
            type="button"
            disabled={busy !== undefined}
            onClick={() => { void run('unlock'); }}
          >
            {busy === 'unlock' ? 'Unlocking…' : 'Unlock record'}
          </AgentButton>
          {loadError ? <p className="error" role="alert">{loadError}</p> : null}
        </section>
      </main>
    );
  }

  if (!record || !activeGroup || !activeResource) {
    return (
      <main className="explore-shell explore-empty">
        <p className="eyebrow">Record explorer</p>
        <h1>No record yet.</h1>
        <p>{loadError ?? 'Connect MyChart to import a record into this browser.'}</p>
        <RouteLink
          to="/"
          agentId="explore-import-cta"
          agentLabel="Import from MyChart"
          agentDescription="Returns to the landing page to start the MyChart import."
          className="button primary"
        >
          Import from MyChart
        </RouteLink>
      </main>
    );
  }

  const selectedPosition = Math.min(resourceIndex, activeGroup.resources.length - 1);
  const displayResource = activeGroup.resources[selectedPosition];
  const totalResources = groups.reduce((total, group) => total + group.resources.length, 0);

  return (
    <main className="explore-shell">
      <section className="explore-heading">
        <div>
          <p className="eyebrow">{status?.connected ? 'Your imported record' : 'Sample record'}</p>
          <AgentTarget
            agentId="explore-patient-name"
            label="Patient name"
            description="Whose record is being displayed."
          >
            <div>
              <h1>{patientDisplayName(record)}</h1>
            </div>
          </AgentTarget>
          <p className="explore-meta">
            From {record.source.provider} · Exported{' '}
            <time dateTime={record.exportedAt}>{new Date(record.exportedAt).toLocaleString()}</time>
          </p>
        </div>
        <div className="explore-actions">
          <AgentButton
            agentId="explore-download"
            agentLabel="Download export"
            agentDescription="Saves the whole record as a JSON file."
            className="button primary"
            type="button"
            disabled={busy !== undefined}
            onClick={() => { void run('download'); }}
          >
            {busy === 'download' ? 'Preparing…' : 'Download export'}
          </AgentButton>
          {status?.connected ? (
            <>
              <AgentButton
                agentId="explore-lock"
                agentLabel="Lock record"
                agentDescription="Discards the decryption key from memory, requiring the passphrase again."
                className="text-button"
                type="button"
                disabled={busy !== undefined}
                onClick={() => { void run('lock'); }}
              >
                Lock record
              </AgentButton>
              <AgentButton
                agentId="explore-remove"
                agentLabel="Remove imported data"
                agentDescription="Permanently deletes the imported record from this browser."
                className="text-button danger-button"
                type="button"
                disabled={busy !== undefined}
                onClick={() => { void run('clear'); }}
              >
                {busy === 'clear' ? 'Removing…' : 'Remove imported data'}
              </AgentButton>
            </>
          ) : null}
        </div>
      </section>

      {loadError ? <div className="error" role="alert">{loadError}</div> : null}

      {errorEntries.length ? (
        <details className="import-warnings">
          <summary>
            {errorEntries.length} resource {errorEntries.length === 1 ? 'type' : 'types'} could not be imported
          </summary>
          <dl>
            {errorEntries.map(([resource, message]) => (
              <div key={resource}><dt>{resource}</dt><dd>{message}</dd></div>
            ))}
          </dl>
        </details>
      ) : null}

      <div className="explore-layout">
        <aside className="explore-sidebar" aria-label="Imported resource types">
          <div className="sidebar-heading">
            <span>Data available</span>
            <strong>{totalResources}</strong>
          </div>
          <div className="resource-nav">
            {groups.map((group) => (
              <AgentButton
                key={group.key}
                agentId={`resource-group-${group.key}`}
                agentLabel={`${group.label} (${group.resources.length})`}
                agentDescription={`Shows the ${group.resources.length} ${group.label} records.`}
                className={group.key === activeGroup.key ? 'active' : undefined}
                type="button"
                aria-current={group.key === activeGroup.key ? 'page' : undefined}
                onClick={() => selectGroup(group.key)}
              >
                <span>{group.label}</span>
                <strong>{group.resources.length}</strong>
              </AgentButton>
            ))}
          </div>
          <p className="local-data-note">
            {status?.connected
              ? 'This record is encrypted and stored only in this browser. Download a backup or remove it when you are finished.'
              : 'This is a de-identified sample record, shown because no MyChart record has been imported.'}
          </p>
        </aside>

        <section className="resource-panel">
          <div className="resource-panel-top">
            <div>
              <p className="resource-kicker">{activeGroup.label}</p>
              <AgentTarget
                agentId="resource-title"
                label="Selected record title"
                description="The title of the record currently shown in the panel."
              >
                <div>
                  <h2>{resourceTitle(displayResource, `${activeGroup.label} item`)}</h2>
                </div>
              </AgentTarget>
            </div>
            <div className="resource-panel-actions">
              {typeof displayResource.key === 'string' ? (
                <>
                  <AgentButton
                    agentId="view-raw-text"
                    agentLabel="View raw file text"
                    agentDescription="Opens the file's raw text in a dialog."
                    className="raw-text-button"
                    type="button"
                    disabled={attachmentTextLoading !== undefined}
                    onClick={() => { void viewAttachmentText(displayResource, 'raw'); }}
                  >
                    {attachmentTextLoading === 'raw' ? 'Opening…' : 'View raw'}
                  </AgentButton>
                  <AgentButton
                    agentId="view-plain-text"
                    agentLabel="View note text"
                    agentDescription="Opens the file's text with markup removed."
                    className="raw-text-button"
                    type="button"
                    disabled={attachmentTextLoading !== undefined}
                    onClick={() => { void viewAttachmentText(displayResource, 'plain'); }}
                  >
                    {attachmentTextLoading === 'plain' ? 'Opening…' : 'View text'}
                  </AgentButton>
                </>
              ) : null}
              <div className="view-switcher" role="tablist" aria-label="Data display">
                <AgentButton
                  agentId="view-rendered"
                  agentLabel="Rendered view"
                  agentDescription="Shows the record formatted for reading."
                  type="button"
                  role="tab"
                  aria-selected={view === 'rendered'}
                  className={view === 'rendered' ? 'active' : undefined}
                  onClick={() => chooseView('rendered')}
                >
                  Rendered
                </AgentButton>
                <AgentButton
                  agentId="view-raw-json"
                  agentLabel="Raw JSON view"
                  agentDescription="Shows the underlying FHIR JSON for this record."
                  type="button"
                  role="tab"
                  aria-selected={view === 'raw'}
                  className={view === 'raw' ? 'active' : undefined}
                  onClick={() => chooseView('raw')}
                >
                  Raw JSON
                </AgentButton>
              </div>
            </div>
          </div>

          {activeGroup.resources.length > 1 ? (
            <div className="resource-pager" aria-label={`${activeGroup.label} item navigation`}>
              <AgentButton
                agentId="resource-previous"
                agentLabel="Previous record"
                agentDescription="Shows the previous record in this group."
                type="button"
                disabled={selectedPosition === 0}
                onClick={() => setResourceIndex(Math.max(0, selectedPosition - 1))}
              >
                Previous
              </AgentButton>
              <span>{selectedPosition + 1} of {activeGroup.resources.length}</span>
              <AgentButton
                agentId="resource-next"
                agentLabel="Next record"
                agentDescription="Shows the next record in this group."
                type="button"
                disabled={selectedPosition === activeGroup.resources.length - 1}
                onClick={() =>
                  setResourceIndex(Math.min(activeGroup.resources.length - 1, selectedPosition + 1))
                }
              >
                Next
              </AgentButton>
            </div>
          ) : null}

          {view === 'rendered' ? (
            <AgentTarget
              agentId="rendered-record"
              label="Rendered record"
              description="The selected record's fields, formatted for readability."
            >
              <div className="rendered-resource" role="tabpanel">
                <p className="rendered-note">
                  Formatted for readability. Use Raw JSON to inspect the source record.
                </p>
                {fields.length ? (
                  <dl className="field-grid">
                    {fields.map((field, index) => (
                      <div key={`${field.label}-${index}`}>
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="no-rendered-fields">
                    No common display fields were found. The complete resource is available in Raw JSON.
                  </p>
                )}
              </div>
            </AgentTarget>
          ) : (
            <AgentTarget
              agentId="raw-record"
              label="Raw FHIR JSON"
              description="The selected record exactly as it came from the provider."
            >
              <div className="raw-resource" role="tabpanel">
                <pre><code>{JSON.stringify(displayResource, null, 2)}</code></pre>
              </div>
            </AgentTarget>
          )}
        </section>
      </div>

      {textPreview ? (
        <TextModal preview={textPreview} onClose={() => setTextPreview(undefined)} />
      ) : null}
    </main>
  );
}

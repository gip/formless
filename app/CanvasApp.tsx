'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import VersionSwitcher from './VersionSwitcher';
import VoicePill from './VoicePill';
import PassphrasePrompt from './PassphrasePrompt';
import { isTrustedPreviewMessage } from '@/lib/bridge';
import type { AppVersion, FileMap, RouteDescriptor, UiElementDescriptor } from '@/lib/canvas-types';
import { computeGrant, respondToCapability, type CapabilityDeps } from '@/lib/host-capabilities';
import { guestStatePort } from '@/lib/guest-state';
import { createHealthPort, epicClientId, epicScope } from '@/lib/health/port';
import { connectAndImport, type ImportProgressReport } from '@/lib/health/import';
import { createImportRelay } from '@/lib/health/import-relay';
import { getProjectController, starterOverlay, type ControllerState } from '@/lib/project-controller';
import { overlayHash } from '@/lib/project-policy';
import { starterPackageHash } from '@/lib/runtime-snapshot';
import {
  fetchVersion,
  listVersions,
  publishVersion,
  readVersionParam,
  unpublishVersion,
  writeVersionParam,
} from '@/lib/version-client';
import {
  getServerSpeechState,
  getSpeechState,
  isNativeWebMcp,
  messageQueue,
  sendPreviewCommand,
  setElements,
  setHealthAccess,
  setPreviewTarget,
  setRoutes,
  setVersionOperations,
  speechPort,
  subscribeNativeWebMcp,
  subscribeSpeech,
} from '@/lib/webmcp-runtime';

const initialControllerState: ControllerState = {
  phase: 'idle',
  detail: 'Preparing the canvas',
  revision: 0,
  previewUrl: null,
  versionId: null,
};

const phaseLabels: Record<ControllerState['phase'], string> = {
  idle: 'Waiting',
  restoring: 'Restoring source',
  booting: 'Booting runtime',
  hydrating: 'Loading runtime',
  mounting: 'Mounting project',
  installing: 'Installing packages',
  starting: 'Starting preview',
  ready: 'Canvas ready',
  validating: 'Validating update',
  error: 'Runtime unavailable',
};

/**
 * Host -> guest push. The preview may not be mounted (a boot in flight, a
 * version switch), and that is not an error: the guest re-reads what it needs
 * when it mounts.
 */
function emitHostEvent(event: string, payload?: unknown): void {
  try {
    sendPreviewCommand('host-event', { event, payload });
  } catch {
    // No preview to tell.
  }
}

export default function CanvasApp() {
  const controller = useMemo(() => getProjectController(), []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nativeWebMcp = useSyncExternalStore(subscribeNativeWebMcp, isNativeWebMcp, () => false);
  const speech = useSyncExternalStore(subscribeSpeech, getSpeechState, getServerSpeechState);
  const [runtime, setRuntime] = useState(initialControllerState);
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [versionBusy, setVersionBusy] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [starterHash, setStarterHash] = useState<string | null>(null);
  const deepLinkRef = useRef(false);

  /**
   * A published version is someone else's code. It has always run cross-origin,
   * away from the host page and the publisher token, but the preview frame also
   * carries `microphone` — fine when the code was yours, less obviously so once
   * anyone can publish. Your own versions and the starter keep speech input;
   * a version you did not publish does not get the microphone.
   */
  const previewAllow = useMemo(() => {
    const version = versions.find((entry) => entry.id === runtime.versionId);
    const base = 'cross-origin-isolated; tools';
    return version && !version.mine ? base : `microphone; ${base}`;
  }, [runtime.versionId, versions]);

  const previewOrigin = useMemo(() => {
    if (!runtime.previewUrl) return null;
    try { return new URL(runtime.previewUrl).origin; } catch { return null; }
  }, [runtime.previewUrl]);

  /**
   * Routes are tagged with the app that declared them. Deriving the visible
   * table from that tag means a version switch drops the old routes without an
   * effect that resets state — `navigate_to_route` can never offer a route
   * belonging to the app the user just left.
   */
  const [declaredRoutes, setDeclaredRoutes] = useState<{ key: string; routes: RouteDescriptor[] }>({
    key: '',
    routes: [],
  });
  const [passphraseRequest, setPassphraseRequest] = useState<{
    mode: 'create' | 'unlock';
    settle: (value: string | null) => void;
  } | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressReport>();
  /**
   * Held separately from `importProgress` because the two do not end together:
   * the attachment pass runs after the last search completes, so a pill keyed on
   * `completedSearches < totalSearches` would go quiet while the import was
   * still downloading files.
   */
  const [importing, setImporting] = useState(false);

  /**
   * Created once, outside the health port, because it outlives any single
   * connect and owns a pending timer.
   */
  const relay = useMemo(
    () => createImportRelay({ emit: emitHostEvent, onReport: setImportProgress }),
    [],
  );

  /**
   * The health port owns the record and the derived key, so it is created once
   * and outlives version switches — the record belongs to the user, not to
   * whichever app is loaded.
   */
  const health = useMemo(() => createHealthPort({
    requestPassphrase: (mode) =>
      new Promise<string | null>((settle) => setPassphraseRequest({ mode, settle })),
    runConnect: async ({ providerId, includeAttachments, passphrase, onImportStart }) => {
      const clientId = epicClientId(providerId);
      if (!clientId) throw new Error('NEXT_PUBLIC_EPIC_CLIENT_ID is not set.');
      try {
        const record = await connectAndImport({
          providerId,
          includeAttachments,
          passphrase,
          clientId,
          ...(epicScope() ? { scope: epicScope()! } : {}),
          onImportStart: (providerName) => {
            onImportStart();
            setImporting(true);
            relay.start(providerId, providerName);
          },
          onProgress: (progress) => relay.progress(progress),
        });
        // Ahead of the port's own `record.changed`, so the guest learns the
        // import ended before it is told there is something new to read.
        relay.finish({ ok: true });
        setImporting(false);
        return record;
      } catch (error) {
        // The guest may have moved to the record view on `import.started`, which
        // is a page with nowhere to show a connect error. So the failure travels
        // with the event that closes the progress panel.
        relay.finish({
          ok: false,
          error: error instanceof Error ? error.message : 'The import failed.',
        });
        setImporting(false);
        throw error;
      }
    },
    emit: emitHostEvent,
  }), [relay]);

  /**
   * The grant is recomputed whenever the loaded version changes, and the message
   * listener below depends on it. Reading it through a ref instead would leave a
   * window after a switch where a `host-request` resolved against the previous
   * app's privileges — briefly handing a stranger's version the access a
   * version you published had.
   */
  const grant = useMemo(() => computeGrant(runtime.versionId, versions), [runtime.versionId, versions]);

  const capabilities = useMemo<CapabilityDeps>(
    () => ({ state: guestStatePort, grant: () => grant, health }),
    [grant, health],
  );

  const previewIdentity = `${runtime.versionId ?? 'starter'}|${runtime.previewUrl ?? ''}`;
  const routes = useMemo(
    () => (declaredRoutes.key === previewIdentity ? declaredRoutes.routes : []),
    [declaredRoutes, previewIdentity],
  );

  useEffect(() => { setRoutes(routes); }, [routes]);

  // The health tools are host-registered, so they read the port directly rather
  // than through the bridge — but they consult the same `computeGrant()` the
  // bridge does, so a version published by someone else is refused the record
  // whichever way it is asked for.
  useEffect(() => {
    setHealthAccess({ snapshot: () => health.snapshot(), grant: () => grant });
    return () => setHealthAccess(null);
  }, [health, grant]);

  useEffect(() => controller.subscribe(setRuntime), [controller]);

  useEffect(() => {
    void controller.boot().catch(() => undefined);
  }, [controller]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedPreviewMessage(event, iframeRef.current?.contentWindow ?? null, previewOrigin)) return;
      const payload = event.data.payload as Record<string, unknown> | undefined;
      if (event.data.type === 'registry' && Array.isArray(payload?.elements)) {
        setElements(payload.elements as UiElementDescriptor[]);
      }
      if (event.data.type === 'user-message' && typeof payload?.text === 'string' && (payload.source === 'typed' || payload.source === 'speech')) {
        try {
          messageQueue.add(payload.text, payload.source);
        } catch { /* Empty preview messages are ignored. */ }
      }
      if (event.data.type === 'manifest') {
        const declared = Array.isArray(payload?.routes) ? (payload.routes as RouteDescriptor[]) : [];
        const clean = declared.filter(
          (route) => route && typeof route.path === 'string' && typeof route.title === 'string',
        );
        setDeclaredRoutes({ key: previewIdentity, routes: clean });
      }
      if (event.data.type === 'host-request' && typeof payload?.id === 'string' && typeof payload?.method === 'string') {
        const { id, method } = payload as { id: string; method: string };
        const params = (payload.params ?? {}) as Record<string, unknown>;
        void respondToCapability(capabilities, id, method, params).then((response) => {
          try {
            sendPreviewCommand('host-response', response as unknown as Record<string, unknown>);
          } catch {
            // The preview went away mid-request; the guest's own timeout covers it.
          }
        });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewOrigin, capabilities, previewIdentity]);

  // Tools are already registered (see lib/webmcp-runtime). All this does is
  // hand the runtime the live preview window once it exists.
  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    setPreviewTarget(frameWindow && previewOrigin ? { window: frameWindow, origin: previewOrigin } : null);
  }, [previewOrigin]);

  const refreshVersions = useCallback(async () => {
    const result = await listVersions();
    if (result.ok) {
      setVersions(result.value);
      setVersionsError(null);
      return result.value;
    }
    setVersionsError(result.reason);
    return [];
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshVersions();
      setStarterHash(await starterPackageHash());
    })();
  }, [refreshVersions]);

  /** Loads an overlay into the live preview. `null` means the starter project. */
  const switchToVersion = useCallback(async (id: string | null): Promise<AppVersion | null> => {
    setVersionBusy(true);
    try {
      let overlay: FileMap = starterOverlay();
      let loaded: AppVersion | null = null;
      if (id !== null) {
        const detail = await fetchVersion(id);
        if (!detail.ok) throw new Error(detail.reason);
        overlay = detail.value.files;
        loaded = detail.value;
      }
      await controller.loadVersion(
        controller.getState().revision,
        overlay,
        loaded ? `Loaded "${loaded.name}"` : 'Starter project restored',
        id,
      );
      writeVersionParam(id);
      setRuntime(controller.getState());
      setVersionsError(null);
      return loaded;
    } catch (error) {
      setVersionsError(error instanceof Error ? error.message : 'The version could not be loaded.');
      throw error;
    } finally {
      setVersionBusy(false);
    }
  }, [controller]);

  const publishCurrent = useCallback(async (name: string, description: string): Promise<AppVersion> => {
    setVersionBusy(true);
    try {
      const hash = starterHash ?? await starterPackageHash();
      const result = await publishVersion({ name, description, starterHash: hash, files: controller.currentOverlay() });
      if (!result.ok) throw new Error(result.reason);
      // The draft on disk already is this version, so point at it rather than
      // reloading the overlay we just uploaded.
      await controller.markPublished(result.value.id);
      writeVersionParam(result.value.id);
      setRuntime(controller.getState());
      await refreshVersions();
      setVersionsError(null);
      return result.value;
    } catch (error) {
      setVersionsError(error instanceof Error ? error.message : 'The version could not be published.');
      throw error;
    } finally {
      setVersionBusy(false);
    }
  }, [controller, refreshVersions, starterHash]);

  const unpublishCurrent = useCallback(async (id: string) => {
    setVersionBusy(true);
    const result = await unpublishVersion(id);
    if (!result.ok) setVersionsError(result.reason);
    // The working copy keeps its files; it is simply no longer a checkout of
    // anything published.
    if (result.ok && controller.getState().versionId === id) {
      await controller.markPublished(null);
      writeVersionParam(null);
      setRuntime(controller.getState());
    }
    await refreshVersions();
    setVersionBusy(false);
  }, [controller, refreshVersions]);

  /**
   * `?version=<id>` loads that version once the runtime is up. This is what
   * makes `open "WebMCP Browser.app" --args --url ".../?version=<id>"` work in
   * the macOS shell, where there is no other way to pick a version at launch.
   */
  useEffect(() => {
    if (deepLinkRef.current || runtime.phase !== 'ready') return;
    const requested = readVersionParam(window.location.search);
    deepLinkRef.current = true;
    if (!requested || requested === runtime.versionId) return;
    void (async () => { await switchToVersion(requested).catch(() => undefined); })();
  }, [runtime.phase, runtime.versionId, switchToVersion]);

  /** Compares the working copy against the version it was checked out from. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const baseline = runtime.versionId
        ? versions.find((version) => version.id === runtime.versionId)?.contentHash
        : await overlayHash(starterOverlay());
      if (cancelled || !baseline) return;
      const current = await overlayHash(controller.currentOverlay());
      if (!cancelled) setDraftDirty(current !== baseline);
    })();
    return () => { cancelled = true; };
  }, [controller, runtime.revision, runtime.versionId, versions]);

  // Tool registration reads these through a ref so publishing or switching does
  // not tear down and re-register every WebMCP tool.
  useEffect(() => {
    setVersionOperations({
      list: refreshVersions,
      publish: async ({ name, description }) => publishCurrent(name, description ?? ''),
      switchTo: async (baseRevision, versionId) => {
        if (baseRevision !== controller.getState().revision) {
          throw new Error(`Revision conflict. Current revision is ${controller.getState().revision}.`);
        }
        const version = await switchToVersion(versionId);
        if (!version) throw new Error('Unknown version.');
        return { revision: controller.getState().revision, version };
      },
      current: () => {
        const id = controller.getState().versionId;
        return { id, name: versions.find((version) => version.id === id)?.name ?? 'Starter project', dirty: draftDirty };
      },
    });
  }, [controller, draftDirty, publishCurrent, refreshVersions, switchToVersion, versions]);

  return (
    <main className="canvas-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">F</div>
        <div className="brand-copy">
          <p className="eyebrow">Formless Health</p>
          <h1>Agent-ready interface lab</h1>
        </div>
        <VersionSwitcher
          versions={versions}
          currentId={runtime.versionId}
          dirty={draftDirty}
          busy={versionBusy || runtime.phase !== 'ready'}
          error={versionsError}
          starterHash={starterHash}
          onSwitch={(id) => { void switchToVersion(id).catch(() => undefined); }}
          onPublish={(name, description) => { void publishCurrent(name, description).catch(() => undefined); }}
          onUnpublish={(id) => { void unpublishCurrent(id); }}
        />
        {importing ? (
          <div className="import-pill" role="status" aria-live="polite">
            {importProgress
              ? `Importing ${importProgress.completedSearches}/${importProgress.totalSearches} · ${importProgress.resourceCount} records`
              : 'Starting import…'}
          </div>
        ) : null}
        <VoicePill
          supported={speech.supported}
          armed={speech.armed}
          speaking={speech.speaking}
          blocked={speech.blocked}
          onArm={() => speechPort.arm()}
          onStop={() => speechPort.stop()}
        />
        <div className={`connection-pill ${nativeWebMcp ? 'online' : ''}`}>
          <span /> {nativeWebMcp ? 'Native WebMCP connected' : 'Local test bridge only'}
        </div>
      </header>

      {passphraseRequest ? (
        <PassphrasePrompt
          mode={passphraseRequest.mode}
          onSubmit={(value) => { passphraseRequest.settle(value); setPassphraseRequest(null); }}
          onCancel={() => { passphraseRequest.settle(null); setPassphraseRequest(null); }}
        />
      ) : null}

      <section className="workspace" aria-label="Formless Health workspace">
        <div className="preview-stage">
          <div className="preview-toolbar">
            <span className="browser-dot red" /><span className="browser-dot amber" /><span className="browser-dot green" />
            <span className="preview-label">Live WebContainer preview</span>
            {routes.length ? (
              <span className="preview-routes" title={routes.map((route) => route.path).join(' ')}>
                {routes.length} route{routes.length === 1 ? '' : 's'}
              </span>
            ) : null}
            <span className={`preview-status ${runtime.phase}`}><i />{phaseLabels[runtime.phase]}</span>
          </div>
          <div className="preview-viewport">
            {runtime.previewUrl ? (
              <iframe
                ref={iframeRef}
                // `allow` is read at load, so it has to be part of the key.
                key={`${runtime.previewUrl}|${previewAllow}`}
                src={`${runtime.previewUrl}/?canvasHost=${encodeURIComponent(window.location.origin)}`}
                title="Editable WebMCP application preview"
                allow={previewAllow}
              />
            ) : (
              <div className={`runtime-splash ${runtime.phase === 'error' ? 'failed' : ''}`}>
                <div className="runtime-orbit"><span /><i /></div>
                <p className="eyebrow">In-browser runtime</p>
                <h2>{runtime.phase === 'error' ? 'The preview could not start' : 'Building your live canvas'}</h2>
                <p>{runtime.detail}</p>
                {runtime.phase === 'error' && <small>Use a Chromium browser with cross-origin isolation and third-party storage enabled.</small>}
              </div>
            )}
          </div>
        </div>

      </section>
    </main>
  );
}

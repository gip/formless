'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import VersionSwitcher from './VersionSwitcher';
import { isTrustedPreviewMessage } from '@/lib/bridge';
import type { AppVersion, FileMap, UiElementDescriptor } from '@/lib/canvas-types';
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
import { isNativeWebMcp, messageQueue, setElements, setPreviewTarget, setVersionOperations, subscribeNativeWebMcp } from '@/lib/webmcp-runtime';

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

export default function CanvasApp() {
  const controller = useMemo(() => getProjectController(), []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nativeWebMcp = useSyncExternalStore(subscribeNativeWebMcp, isNativeWebMcp, () => false);
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
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewOrigin]);

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
        <div className="brand-mark" aria-hidden="true">W</div>
        <div className="brand-copy">
          <p className="eyebrow">WebAlly</p>
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
        <div className={`connection-pill ${nativeWebMcp ? 'online' : ''}`}>
          <span /> {nativeWebMcp ? 'Native WebMCP connected' : 'Local test bridge only'}
        </div>
      </header>

      <section className="workspace" aria-label="WebAlly workspace">
        <div className="preview-stage">
          <div className="preview-toolbar">
            <span className="browser-dot red" /><span className="browser-dot amber" /><span className="browser-dot green" />
            <span className="preview-label">Live WebContainer preview</span>
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

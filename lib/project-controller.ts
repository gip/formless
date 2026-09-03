'use client';

import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { FileMap, ProjectChange, ProjectFileDescriptor, RuntimePhase } from './canvas-types';
import { toFileTree } from './file-tree';
import { hashText } from './hash';
import { loadSnapshot, saveSnapshot } from './persistence';
import { extractOverlay, isEditablePath, listVisiblePaths, normalizeProjectPath, validateChanges, validateOverlay } from './project-policy';
import { fetchRuntimeSnapshot, type RuntimeSnapshotResult } from './runtime-snapshot';
import { cloneStarterFiles, STARTER_FILES } from './starter-project';

type StateListener = (state: ControllerState) => void;

export interface ControllerState {
  phase: RuntimePhase;
  detail: string;
  revision: number;
  previewUrl: string | null;
  /** The published version the working copy is based on; null for the starter. */
  versionId: string | null;
}

function mergeSnapshot(files: FileMap | undefined): FileMap {
  const merged = cloneStarterFiles();
  if (!files) return merged;
  for (const [path, content] of Object.entries(files)) {
    if (isEditablePath(path) && typeof content === 'string') merged[path] = content;
  }
  for (const path of Object.keys(merged)) {
    if (isEditablePath(path) && !(path in files)) delete merged[path];
  }
  return merged;
}

/** The starter project expressed as a version overlay. */
export function starterOverlay(): FileMap {
  return extractOverlay(STARTER_FILES);
}

export class ProjectController {
  private container: WebContainer | null = null;
  private serverProcess: WebContainerProcess | null = null;
  private files: FileMap = cloneStarterFiles();
  private listener: StateListener = () => undefined;
  private bootPromise: Promise<void> | null = null;
  private state: ControllerState = {
    phase: 'idle',
    detail: 'Waiting to start',
    revision: 0,
    previewUrl: null,
    versionId: null,
  };

  subscribe(listener: StateListener): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = () => undefined;
    };
  }

  getState(): ControllerState {
    return this.state;
  }

  private emit(patch: Partial<ControllerState>) {
    this.state = { ...this.state, ...patch };
    this.listener(this.state);
  }

  boot(): Promise<void> {
    if (!this.bootPromise) this.bootPromise = this.performBoot();
    return this.bootPromise;
  }

  private async performBoot(): Promise<void> {
    try {
      this.emit({ phase: 'restoring', detail: 'Restoring the latest validated snapshot' });
      // Both network fetches start before the container boots so the prebuilt
      // runtime download overlaps `WebContainer.boot()`.
      const runtimeSnapshot = fetchRuntimeSnapshot();
      const apiModule = import('@webcontainer/api');

      const snapshot = await loadSnapshot();
      this.files = mergeSnapshot(snapshot?.files);
      this.state.revision = snapshot?.revision ?? 0;
      this.state.versionId = snapshot?.versionId ?? null;

      this.emit({ phase: 'booting', detail: 'Booting the in-browser runtime' });
      const api = await apiModule;
      const clientKey = process.env.NEXT_PUBLIC_WEBCONTAINER_API_KEY;
      if (clientKey) api.configureAPIKey(clientKey);
      this.container = await api.WebContainer.boot({ coep: 'require-corp', forwardPreviewErrors: 'exceptions-only' });
      this.container.on('error', ({ message }) => this.emit({ phase: 'error', detail: message }));

      if (!await this.hydrateFromRuntimeSnapshot(await runtimeSnapshot)) {
        this.emit({ phase: 'mounting', detail: 'Mounting the editable React project' });
        await this.container.mount(toFileTree(this.files));

        this.emit({ phase: 'installing', detail: 'Installing the preview dependencies' });
        const install = await this.container.spawn('npm', ['install']);
        const installOutput = this.collectOutput(install);
        if (await install.exit !== 0) {
          throw new Error(`Dependency installation failed. ${await installOutput}`);
        }
        await installOutput;
      }
      await this.startServer();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The WebContainer could not start.';
      this.emit({ phase: 'error', detail });
      throw error;
    }
  }

  /**
   * Mounts the prebuilt `node_modules` + starter tree, then overlays the
   * restored source on top. Replaces a ~14s `npm install` with a ~50ms mount.
   * Returns false when the snapshot is missing, stale, or unmountable, in
   * which case the caller falls back to installing from the registry.
   */
  private async hydrateFromRuntimeSnapshot(result: RuntimeSnapshotResult): Promise<boolean> {
    if (!this.container) return false;
    if (!result.ok) {
      console.warn(`[canvas] Prebuilt runtime unavailable (${result.reason}); installing from the registry.`);
      return false;
    }
    try {
      this.emit({ phase: 'hydrating', detail: 'Mounting the prebuilt preview runtime' });
      await this.container.mount(result.bytes);

      this.emit({ phase: 'mounting', detail: 'Mounting the editable React project' });
      await this.container.mount(toFileTree(this.files));
      await this.pruneSnapshotEditableFiles();
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'mount failed';
      console.warn(`[canvas] Prebuilt runtime could not be mounted (${detail}); installing from the registry.`);
      return false;
    }
  }

  /** Drops editable starter files the restored project no longer contains. */
  private async pruneSnapshotEditableFiles(): Promise<void> {
    if (!this.container) return;
    for (const path of Object.keys(STARTER_FILES)) {
      if (isEditablePath(path) && !(path in this.files)) {
        await this.container.fs.rm(path, { force: true }).catch(() => undefined);
      }
    }
  }

  private async startServer(): Promise<void> {
    if (!this.container) throw new Error('WebContainer is not available.');
    this.emit({ phase: 'starting', detail: 'Starting the live preview' });
    const ready = new Promise<string>((resolve) => {
      const unsubscribe = this.container!.on('server-ready', (_port, url) => {
        unsubscribe();
        resolve(url);
      });
    });
    this.serverProcess = await this.container.spawn('npm', ['run', 'dev']);
    void this.collectOutput(this.serverProcess);
    const previewUrl = await ready;
    this.emit({ phase: 'ready', detail: 'Live preview ready', previewUrl, revision: this.state.revision });
  }

  private async stopServer(): Promise<void> {
    this.serverProcess?.kill();
    if (this.serverProcess) await this.serverProcess.exit.catch(() => undefined);
    this.serverProcess = null;
  }

  private async collectOutput(process: WebContainerProcess): Promise<string> {
    let output = '';
    await process.output.pipeTo(new WritableStream({
      write(chunk) {
        output = (output + String(chunk)).slice(-12000);
      },
    }));
    return output.trim();
  }

  async listFiles(): Promise<{ revision: number; files: ProjectFileDescriptor[] }> {
    const files = await Promise.all(listVisiblePaths(this.files).map(async (path) => ({
      path,
      editable: isEditablePath(path),
      bytes: new TextEncoder().encode(this.files[path]).byteLength,
      hash: await hashText(this.files[path]),
    })));
    return { revision: this.state.revision, files };
  }

  async readFiles(paths: unknown, requestedRevision?: unknown) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20 || !paths.every((path) => typeof path === 'string')) {
      throw new Error('paths must contain between 1 and 20 project paths.');
    }
    if (requestedRevision !== undefined && requestedRevision !== this.state.revision) {
      throw new Error(`Revision conflict. Current revision is ${this.state.revision}.`);
    }
    const files = await Promise.all(paths.map(async (value) => {
      const path = normalizeProjectPath(value as string);
      const content = this.files[path];
      if (content === undefined) throw new Error(`Unknown project file: ${path}`);
      if (new TextEncoder().encode(content).byteLength > 256 * 1024) throw new Error(`File is too large to read: ${path}`);
      return { path, content, hash: await hashText(content) };
    }));
    return { revision: this.state.revision, files };
  }

  async applyChanges(baseRevision: unknown, input: unknown) {
    if (!this.container) throw new Error('The project runtime is not ready.');
    if (baseRevision !== this.state.revision) throw new Error(`Revision conflict. Current revision is ${this.state.revision}.`);
    const changes = validateChanges(input as ProjectChange[]);
    const previous = { ...this.files };

    this.emit({ phase: 'validating', detail: 'Validating the proposed source update' });
    try {
      for (const change of changes) {
        if (change.operation === 'delete') {
          delete this.files[change.path];
          await this.container.fs.rm(change.path, { force: true });
        } else {
          const directory = change.path.split('/').slice(0, -1).join('/');
          if (directory) await this.container.fs.mkdir(directory, { recursive: true });
          this.files[change.path] = change.content ?? '';
          await this.container.fs.writeFile(change.path, change.content ?? '');
        }
      }

      const validation = await this.container.spawn('npm', ['run', 'validate']);
      const outputPromise = this.collectOutput(validation);
      const exitCode = await Promise.race([
        validation.exit,
        new Promise<number>((resolve) => window.setTimeout(() => {
          validation.kill();
          resolve(124);
        }, 45_000)),
      ]);
      const diagnostics = await Promise.race([
        outputPromise,
        new Promise<string>((resolve) => window.setTimeout(() => resolve('Validation process did not close its output stream.'), 1_500)),
      ]);
      if (exitCode !== 0) throw new Error(exitCode === 124 ? `Validation timed out. ${diagnostics}` : diagnostics || 'Project validation failed.');

      this.state.revision += 1;
      await saveSnapshot(this.state.revision, this.files, this.state.versionId);
      this.emit({ phase: 'ready', detail: 'Live preview ready', revision: this.state.revision });
      return {
        ok: true,
        revision: this.state.revision,
        changedFiles: changes.map((change) => change.path),
        validation: diagnostics,
      };
    } catch (error) {
      await this.restoreFiles(previous);
      this.files = previous;
      this.emit({ phase: 'ready', detail: 'Update rejected; previous preview restored' });
      throw new Error(`Update rolled back. ${error instanceof Error ? error.message : 'Validation failed.'}`);
    }
  }

  async reset(baseRevision: unknown, confirm: unknown) {
    if (confirm !== true) throw new Error('Reset requires confirm: true.');
    // The starter's own overlay, not `{}` — an empty overlay means "this
    // version deleted every editable file", which is a legal version but the
    // opposite of a reset.
    return this.loadVersion(baseRevision, starterOverlay(), 'Starter project restored');
  }

  /**
   * Replaces the editable surface with a published version's overlay.
   *
   * Deliberately does not run `npm run validate`: an overlay can only have been
   * published from a draft that already passed validation in `applyChanges`, so
   * revalidating would spend up to 45s reconfirming a known-good tree. A switch
   * is a `restoreFiles` plus Vite HMR — a few hundred milliseconds.
   *
   * The revision still increments, so an `apply_project_changes` call that was
   * in flight across the switch carries a stale `baseRevision` and fails rather
   * than writing the user's edits into the version they just left.
   */
  async loadVersion(baseRevision: unknown, overlay: unknown, detail = 'Version loaded', versionId: string | null = null) {
    if (!this.container) throw new Error('The project runtime is not ready.');
    if (baseRevision !== this.state.revision) throw new Error(`Revision conflict. Current revision is ${this.state.revision}.`);
    const files = mergeSnapshot(validateOverlay(overlay));
    const previous = { ...this.files };

    this.emit({ phase: 'validating', detail: 'Switching the live preview' });
    try {
      await this.restoreFiles(files, true);
      this.files = files;
      this.state.revision += 1;
      this.state.versionId = versionId;
      await saveSnapshot(this.state.revision, this.files, versionId);
      this.emit({ phase: 'ready', detail, revision: this.state.revision, versionId });
      return { ok: true, revision: this.state.revision, versionId };
    } catch (error) {
      await this.restoreFiles(previous, true);
      this.files = previous;
      this.emit({ phase: 'ready', detail: 'Switch failed; previous preview restored' });
      throw new Error(`Version switch rolled back. ${error instanceof Error ? error.message : 'Write failed.'}`);
    }
  }

  /** The editable overlay of the current working copy. */
  currentOverlay(): FileMap {
    return extractOverlay(this.files);
  }

  /**
   * Points the working copy at a version without touching the files — used
   * after publishing, where the draft on disk already *is* that version, and
   * after unpublishing, where it is no longer a checkout of anything.
   */
  async markPublished(versionId: string | null): Promise<void> {
    this.state.versionId = versionId;
    await saveSnapshot(this.state.revision, this.files, versionId);
    this.emit({ versionId });
  }

  private async restoreFiles(target: FileMap, removeEditable = false): Promise<void> {
    if (!this.container) return;
    const knownPaths = new Set([...Object.keys(this.files), ...Object.keys(target)]);
    for (const path of knownPaths) {
      if ((removeEditable || !(path in target)) && isEditablePath(path)) {
        await this.container.fs.rm(path, { force: true }).catch(() => undefined);
      }
    }
    for (const [path, content] of Object.entries(target)) {
      const directory = path.split('/').slice(0, -1).join('/');
      if (directory) await this.container.fs.mkdir(directory, { recursive: true });
      await this.container.fs.writeFile(path, content);
    }
  }
}

let controller: ProjectController | null = null;

export function getProjectController(): ProjectController {
  controller ??= new ProjectController();
  return controller;
}

export function getStarterRevision(): FileMap {
  return { ...STARTER_FILES };
}

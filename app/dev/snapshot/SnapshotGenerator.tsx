'use client';

import { useRef, useState } from 'react';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { toFileTree } from '@/lib/file-tree';
import { RUNTIME_SNAPSHOT_SCHEMA, starterPackageHash, type RuntimeManifest } from '@/lib/runtime-snapshot';
import { cloneStarterFiles } from '@/lib/starter-project';

const VITE_DEPS_METADATA = 'node_modules/.vite/deps/_metadata.json';

interface GeneratedSnapshot {
  manifest: RuntimeManifest;
  gzip: Uint8Array;
  dataUrl: () => Promise<string>;
}

declare global {
  interface Window {
    __canvasSnapshot?: GeneratedSnapshot;
  }
}

function drain(process: WebContainerProcess, log: (line: string) => void) {
  void process.output.pipeTo(new WritableStream({
    write(chunk) {
      const text = String(chunk).replaceAll(/\[[0-9;]*[A-Za-z]/g, '').trim();
      if (text) log(text);
    },
  })).catch(() => undefined);
}

async function waitForFile(container: WebContainer, path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await container.fs.readFile(path);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

function toDataUrl(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: 'application/gzip' }));
  });
}

function download(name: string, bytes: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function SnapshotGenerator() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GeneratedSnapshot | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const log = (line: string) => setLines((current) => [...current.slice(-200), line]);

  async function generate() {
    setBusy(true);
    setResult(null);
    setLines([]);
    try {
      log('Booting a clean WebContainer…');
      const api = await import('@webcontainer/api');
      const clientKey = process.env.NEXT_PUBLIC_WEBCONTAINER_API_KEY;
      if (clientKey) api.configureAPIKey(clientKey);
      const container = await api.WebContainer.boot({ coep: 'require-corp' });

      log('Mounting the starter project…');
      await container.mount(toFileTree(cloneStarterFiles()));

      log('Running npm install…');
      const install = await container.spawn('npm', ['install']);
      drain(install, log);
      if (await install.exit !== 0) throw new Error('npm install failed.');

      // Starting the dev server once resolves rolldown's wasm binding and
      // loading the preview populates node_modules/.vite/deps. Both land in
      // the export, so the shipped runtime boots warm.
      log('Starting the dev server to warm the runtime…');
      const ready = new Promise<string>((resolve) => {
        const unsubscribe = container.on('server-ready', (_port, url) => {
          unsubscribe();
          resolve(url);
        });
      });
      const dev = await container.spawn('npm', ['run', 'dev']);
      drain(dev, log);
      const previewUrl = await ready;

      log('Loading the preview to warm the dependency pre-bundle…');
      if (frameRef.current) frameRef.current.src = previewUrl;
      const warmed = await waitForFile(container, VITE_DEPS_METADATA, 30_000);
      log(warmed ? 'Dependency pre-bundle cached.' : 'WARNING: no .vite/deps cache; the runtime will pre-bundle on first boot.');
      if (frameRef.current) frameRef.current.src = 'about:blank';

      dev.kill();
      await dev.exit.catch(() => undefined);

      log('Exporting the container filesystem…');
      const raw = await container.export('.', { format: 'binary' });
      const gzip = new Uint8Array(await new Response(
        new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer());

      const manifest: RuntimeManifest = {
        schemaVersion: RUNTIME_SNAPSHOT_SCHEMA,
        packageHash: await starterPackageHash(),
        rawBytes: raw.byteLength,
        gzipBytes: gzip.byteLength,
        generatedAt: new Date().toISOString(),
      };
      const generated: GeneratedSnapshot = { manifest, gzip, dataUrl: () => toDataUrl(gzip) };
      setResult(generated);
      window.__canvasSnapshot = generated;
      log(`Done. ${(raw.byteLength / 1048576).toFixed(1)}MB raw, ${(gzip.byteLength / 1048576).toFixed(1)}MB gzipped.`);
    } catch (error) {
      log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 32, fontFamily: 'ui-sans-serif, system-ui', maxWidth: 860, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>Guest runtime snapshot</h1>
      <p style={{ margin: '0 0 20px', color: '#5a6675', lineHeight: 1.6 }}>
        Installs the guest project in a throwaway WebContainer, warms it, and exports the filesystem.
        Save both files into <code>public/guest-runtime/</code> and commit them. Regenerate whenever the
        guest <code>package.json</code> changes — the canvas falls back to <code>npm install</code> when
        the manifest hash stops matching.
      </p>

      <button type="button" onClick={generate} disabled={busy} style={{ padding: '11px 18px', borderRadius: 10, border: 0, background: '#142235', color: '#fff', fontWeight: 700, cursor: busy ? 'progress' : 'pointer' }}>
        {busy ? 'Building…' : 'Generate snapshot'}
      </button>

      {result && (
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={() => download('runtime.gz', result.gzip as BlobPart, 'application/gzip')} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #cbd3dc', background: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            Download runtime.gz
          </button>
          <button type="button" onClick={() => download('manifest.json', JSON.stringify(result.manifest, null, 2), 'application/json')} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #cbd3dc', background: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            Download manifest.json
          </button>
        </div>
      )}

      <pre style={{ marginTop: 20, padding: 16, borderRadius: 12, background: '#0f1722', color: '#cbd6e4', fontSize: 12, lineHeight: 1.55, maxHeight: 420, overflow: 'auto' }}>
        {lines.join('\n') || 'Idle.'}
      </pre>

      <iframe ref={frameRef} title="Runtime warm-up preview" style={{ width: 1, height: 1, opacity: 0, position: 'absolute', pointerEvents: 'none' }} />
    </main>
  );
}

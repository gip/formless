import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // Poll instead of trusting filesystem events. Source here is not written by
    // a shell inside the container — the host writes it from the outside with
    // `WebContainer.fs.writeFile` (`ProjectController.applyChanges`). Those
    // writes do not reliably surface as `fs.watch` events to chokidar, so an
    // `apply_project_changes` could validate, bump the revision, and persist,
    // while the dev server kept serving the previous bundle; the only recovery
    // was reloading the host page, which reboots the whole WebContainer.
    // The watched surface is `src/` plus `public/` — a few dozen small files,
    // since Vite's default `ignored` already excludes node_modules and .git —
    // so polling costs far less than a stale preview.
    watch: { usePolling: true, interval: 250 },
  },
});

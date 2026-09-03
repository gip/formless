import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `?raw` imports of guest CSS return an empty stub unless Vitest processes
    // CSS; lib/starter-project.ts inlines guest/src/styles/*.css that way.
    css: true,
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
});


/**
 * Tailwind was configured inline in `vite.config.ts` while the host built with
 * Vite. Next reads PostCSS from this file instead.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;

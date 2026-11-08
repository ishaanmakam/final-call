import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The simulator imports the REAL rules oracle (packages/rules/src/index.ts) through this alias, so
// every money number on screen comes from the same code the database is differential-tested against.
const rulesEntry = fileURLToPath(new URL('../packages/rules/src/index.ts', import.meta.url));
const rulesDir = fileURLToPath(new URL('../packages/rules', import.meta.url));

export default defineConfig({
  // GitHub Pages serves the site under /final-call/; `VITE_BASE=/` for a local preview at the root.
  base: process.env.VITE_BASE ?? '/final-call/',
  plugins: [react()],
  resolve: {
    alias: { '@final-call/rules': rulesEntry },
  },
  server: {
    fs: { allow: ['.', rulesDir] },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    css: false,
  },
});

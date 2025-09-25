import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: path.resolve(__dirname, 'tests/setup.ts'),
    include: ['tests/unit/**/*.spec.ts?(x)'],
    exclude: ['tests/e2e/**'],
    coverage: {
      reporter: ['text', 'lcov']
    }
  }
});

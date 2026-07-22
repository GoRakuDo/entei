import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/i18n/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@i18n': '/src/i18n',
      '@components': '/src/components',
      '@layouts': '/src/layouts',
      '@styles': '/src/styles',
      '@scripts': '/src/scripts',
      '@': '/src',
    },
  },
});

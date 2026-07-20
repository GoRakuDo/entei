import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
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
    },
  },
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import vue from '@vitejs/plugin-vue';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

import { playwright } from '@vitest/browser-playwright';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  // The vitest servers do not inherit the app's vite.config.ts, so re-apply
  // what components need here (mirrors vite.config.ts minus its build-only
  // plugins): the Vue SFC transform, the `@` alias and the build-version
  // define. Applied at root so both the storybook preview server and the
  // browser test server transform .vue files.
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.join(dirname, 'src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('vitest'),
  },
  // force pre-bundling of CJS deps whose named/default exports the browser
  // bundle cannot resolve from raw sources (see the storybook project's
  // server.deps.inline below)
  optimizeDeps: {
    include: ['aria-query', 'lz-string', 'fast-deep-equal', 'pretty-format', 'react-is', 'util-deprecate'],
  },
  test: {
    // the unit project legitimately has zero tests until logic tests land
    passWithNoTests: true,
    projects: [
      {
        // Pure-logic unit tests (no DOM): plain *.test.ts next to the logic.
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          // Stylesheets are read as text by the z-index gate (src/styles/zIndex.test.ts
          // parses the --z-* ladder out of styles/tokens.css). Without this Vitest
          // replaces every CSS import with an empty stub, so `?raw` yields "".
          css: true,
          // Russian is the product default: pin it so the suite does not depend
          // on the Node navigator.language ("en-US") through the "auto" setting.
          setupFiles: ['src/i18n/testLocale.ts'],
        },
      },
      {
        extends: true,
        plugins: [
          // The plugin runs tests for the stories defined in your Storybook config
          storybookTest({ configDir: path.join(dirname, '.storybook') }),
        ],
        test: {
          name: 'storybook',
          server: {
            deps: {
              // CJS deps of @storybook/@testing-library with dynamic exports that
              // break raw-source named imports in browser mode ("does not provide
              // an export named 'elementRoles'" etc.) — pre-bundled via
              // optimizeDeps.include above.
              inline: ['aria-query'],
            },
          },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(process.env.PLAYWRIGHT_CHANNEL ? { launchOptions: { channel: process.env.PLAYWRIGHT_CHANNEL } } : {}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
import { defineConfig } from '@rsbuild/core';
import { pluginLess } from '@rsbuild/plugin-less';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  html: {
    title: 'AI Knowledge Agent',
  },
  source: {
    entry: {
      index: './src/main.tsx',
    },
    define: {
      'process.env.API_BASE_URL': JSON.stringify(process.env.API_BASE_URL || 'http://localhost:8000'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/auth': 'http://localhost:8000',
      '/workspaces': 'http://localhost:8000',
      '/library': 'http://localhost:8000',
      '/notta-brain': 'http://localhost:8000',
    },
  },
  output: {
    cssModules: {
      mode: 'local',
    },
  },
  plugins: [pluginReact(), pluginLess()],
});

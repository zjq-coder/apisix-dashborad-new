import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      '@monaco-editor/react',
      'monaco-editor/editor/editor.api',
      'monaco-editor/language/json/monaco.contribution',
      'monaco-editor/editor/contrib/codelens/browser/codeLensCache',
      'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsController',
      'monaco-editor/editor/common/services/treeViewsDndService',
      'monaco-editor/editor/contrib/suggest/browser/suggestMemory',
      'monaco-editor/platform/actionWidget/browser/actionWidget',
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:18080', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:18080', changeOrigin: false },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor')) return 'editor';
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design'))
            return 'design';
        },
      },
    },
  },
});

/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 22101, strictPort: true },
  preview: { host: '127.0.0.1', port: 22102, strictPort: true },
  test: { environment: 'node' },
});

import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import dts from "vite-plugin-dts";
import suidPlugin from "@suid/vite-plugin";

export default defineConfig({
  publicDir: false,
  plugins: [
    suidPlugin(),
    solidPlugin(),
    dts({ insertTypesEntry: true }),
  ],
  build: {
    minify: 'terser',
    lib: {
      entry: './src/index.tsx',
      name: 'ZapThreads',
      fileName: 'zapthreads',
      formats: ['es', 'umd', 'iife']
    },
  },
});
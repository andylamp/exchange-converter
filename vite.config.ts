import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: '/exchange-converter/',
  plugins: [preact()],
  build: { target: 'es2022' },
});

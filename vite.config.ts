import { defineConfig } from 'vite';

// Must match the GitHub repo name for Pages project sites.
export default defineConfig({
  base: '/ar-visor/',
  server: { host: true }
});

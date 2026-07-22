// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  // Must match the domain actually being served, or every absolute og:image and
  // canonical URL points at a host that does not resolve — link previews break.
  // 20072026.com is the permanent domain.
  site: 'https://20072026.com',

  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [sitemap()]
});
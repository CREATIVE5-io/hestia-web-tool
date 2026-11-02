import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates the PWA icons in public/ from public/favicon.svg: npm run generate-pwa-assets
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: '#0f172a' } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: '#0f172a' } },
  },
  images: ['public/favicon.svg'],
});

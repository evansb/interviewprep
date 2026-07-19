import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { sidebar } from './src/generated/navigation.mjs';

const [githubOwner = '', githubRepo = ''] = (process.env.GITHUB_REPOSITORY || '').split('/');
const site = process.env.SITE_URL || (githubOwner ? `https://${githubOwner}.github.io` : 'https://example.com');
const inferredBase = githubRepo && githubRepo !== `${githubOwner}.github.io` ? `/${githubRepo}/` : '/';
const base = (process.env.BASE_PATH || inferredBase).replace(/^([^/])/, '/$1').replace(/([^/])$/, '$1/');

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'The Low-Latency C++ Interview Bible',
      description: 'Interview-focused C++, systems, networking, and low-latency engineering.',
      favicon: '/favicon.svg',
      logo: {
        src: './public/logo.svg',
        alt: 'Low-Latency C++ Interview Bible',
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/BookFooter.astro',
      },
      sidebar,
      pagefind: true,
      disable404Route: true,
      lastUpdated: false,
      credits: false,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0b1728' } },
        { tag: 'meta', attrs: { property: 'og:type', content: 'book' } },
      ],
    }),
  ],
});

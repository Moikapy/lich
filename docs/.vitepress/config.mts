import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/lich/',
  title: 'Lich',
  description:
    'A TypeScript AI agent harness — Think-Act-Observe loop, provider failover, tools, gateway, TUI.',
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    outline: [2, 3]
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'CLI', link: '/user-guide/cli' },
      { text: 'TUI', link: '/user-guide/tui' },
      { text: 'Gateway', link: '/user-guide/gateway' },
      { text: 'Library', link: '/user-guide/library' },
      { text: 'Architecture', link: '/architecture/overview' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'CLI reference', link: '/user-guide/cli' },
          { text: 'TUI guide', link: '/user-guide/tui' },
          { text: 'Gateway guide', link: '/user-guide/gateway' },
          { text: 'Library guide', link: '/user-guide/library' },
          { text: 'Games guide', link: '/user-guide/games' },
          { text: 'Redot guide', link: '/user-guide/redot' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/overview' },
          { text: 'Agent loop', link: '/architecture/agent-loop' },
          { text: 'Providers', link: '/architecture/providers' },
          { text: 'Tools', link: '/architecture/tools' },
          { text: 'Extending', link: '/architecture/extending' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/moikapy/lich' }
    ],
    search: {
      provider: 'local'
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Lich contributors'
    }
  }
})
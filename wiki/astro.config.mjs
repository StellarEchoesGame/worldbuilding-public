import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://wiki.stellar-echoes.online',
  integrations: [starlight({
    title: '群星回响 · Wiki',
    description: '走进群星回响的宇宙：航约428的远汐星域、被战争迫使离港的归航号、船上的居民与相遇的文明，以及将世界化为形体的制作档案。',
    defaultLocale: 'root',
    locales: { root: { label: '简体中文', lang: 'zh-CN' } },
    favicon: '/favicon.svg',
    customCss: ['./src/styles/wiki.css'],
    components: { Footer: './src/components/Footer.astro', ThemeProvider: './src/components/LightTheme.astro', ThemeSelect: './src/components/NoThemeSelect.astro' },
    expressiveCode: { themes: ['github-light'], useStarlightDarkModeSwitch: false },
    sidebar: [
      { label: '世界与档案首页', link: '/' },
      { label: '世界设定', items: [
        { label: '从这里开始 · 世界概览', slug: 'world/overview' },
        { label: '时代、空间与历史', slug: 'world/history' },
        { label: '远汐星域、晷川与息壤', slug: 'world/places' },
        { label: '文明与相遇', slug: 'world/civilization' },
        { label: '战争与启航', slug: 'world/war' },
        { label: '科技与能力边界', slug: 'world/technology' },
      ] },
      { label: '归航号与人', items: [
        { label: '归航号 · 移动的家园', slug: 'world/ark' },
        { label: '居民与共同生活', slug: 'world/people' },
        { label: '航程、舰长与玩家', slug: 'world/voyage' },
        { label: '宇宙规则与固定事实', slug: 'world/rules' },
      ] },
      { label: '视觉设计档案', collapsed: true, items: [
        { label: '手稿图鉴', link: '/gallery/' },
        { label: '母舰设计', slug: 'ship/overview' },
        { label: '多视图与结构', slug: 'ship/views' },
        { label: '港口与机库', slug: 'ship/ports' },
        { label: '舰内生活', slug: 'ship/interiors' },
        { label: '四十八人邻里单元', slug: 'ship/neighborhood' },
        { label: '探索 · 战斗 · 采集', slug: 'units/overview' },
        { label: '逐图生成提示词', link: '/prompts/' },
      ] },
      { label: '制作过程', collapsed: true, items: [
        { label: '后续制作路线图', slug: 'process/roadmap' },
        { label: '制作时间线', slug: 'process/timeline' },
        { label: '设计决策', slug: 'process/decisions' },
        { label: '评审与待办', slug: 'process/reviews' },
        { label: '版本档案', slug: 'process/archive' },
      ] },
      { label: '关于这份 Wiki', collapsed: true, items: [
        { label: '阅读指南', slug: 'guide/about' },
        { label: '持续记录的方法', slug: 'guide/contributing' },
      ] },
    ],
    head: [
      { tag: 'meta', attrs: { property: 'og:image', content: 'https://wiki.stellar-echoes.online/art/current/01-master-study.png' } },
      { tag: 'meta', attrs: { name: 'theme-color', content: '#fbfaf6' } },
    ],
  })],
});

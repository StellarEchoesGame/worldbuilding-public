import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://wiki.stellar-echoes.online',
  integrations: [starlight({
    title: '群星回响 · Wiki',
    description: '走进群星回响的宇宙：航路历史、文明、星域、归航号与船员，以及将世界化为形体的制作档案。',
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
        { label: '航路与时代', slug: 'world/history' },
        { label: '宇宙规则', slug: 'world/rules' },
        { label: '文明与值守公约', slug: 'world/civilization' },
        { label: '科技与能力边界', slug: 'world/technology' },
      ] },
      { label: '星域、方舟与人', items: [
        { label: '潮汐之庭', slug: 'world/tidal-garden' },
        { label: '归航号 · 移动的家园', slug: 'world/ark' },
        { label: '船员与共同生活', slug: 'world/people' },
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

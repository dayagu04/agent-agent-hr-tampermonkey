import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monkey, { cdn } from 'vite-plugin-monkey'
import pkg from './package.json'

// 平台 URL 匹配规则（插件仅在这些页面注入）
// 2026-06-27: 先上线已验证平台（智联、51），BOSS/猎聘待补登录态验证
const matchUrls = [
  // ✅ 智联招聘
  'https://sou.zhaopin.com/*',
  'https://www.zhaopin.com/*',
  // ✅ 51前程无忧
  'https://we.51job.com/pc/search*',
  'https://search.51job.com/*',
  // ✅ BOSS 直聘（2026-07-29 启用：服务器 Playwright 被风控，改由浏览器插件投递）
  // 2026-08-02 扩展：加整域名，BOSS 首页也能注入（悬浮球/面板）；
  // 下方三条具体规则保留作文档，避免删掉后想不起来哪些路径是核心页
  'https://www.zhipin.com/*',
  'https://www.zhipin.com/web/geek/job*',
  'https://www.zhipin.com/web/geek/jobs*',
  'https://www.zhipin.com/job_detail/*',
  'https://www.zhipin.com/web/geek/chat*',

  // ⏸ 猎聘待验证选择器后启用
  // 'https://www.liepin.com/zhaopin/*',
  // 'https://m.liepin.com/*',
]

export default defineConfig({
  plugins: [
    vue(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: '智能求职助手 - 社招自动投递',
        namespace: 'agent-agent-hr',
        // 从 package.json 读，避免与 src/version.ts、App.vue 显示值漂移
        // （实测曾漂成 0.1.0 / 0.2.0 / 0.3.0 三个值）
        version: pkg.version,
        // 独立仓库发布：打 tag 后 CI 把产物挂到 GitHub Release，
        // Tampermonkey 按 @version 自动检查更新
        updateURL: 'https://github.com/dayagu04/agent-agent-hr-tampermonkey/releases/latest/download/agent-agent-hr-tampermonkey.user.js',
        downloadURL: 'https://github.com/dayagu04/agent-agent-hr-tampermonkey/releases/latest/download/agent-agent-hr-tampermonkey.user.js',
        description: '在智联/51前程上按匹配度自动筛选并投递岗位（BOSS/猎聘即将支持）',
        author: 'agent-agent-hr',
        match: matchUrls,
        // 允许跨域请求后端 API（白名单：生产域名 + 本地开发）
        // 注意：@connect 只接受域名/IP，不能带端口号——写成 'localhost:8010'
        // 会被 Tampermonkey 忽略，导致 GM_xmlhttpRequest 报「网络请求失败」。
        connect: ['gudaya.chat', 'localhost', '127.0.0.1'],
        grant: [
          'GM_xmlhttpRequest',
          'GM_setValue',
          'GM_getValue',
          'GM_deleteValue',
          'GM_addStyle',
        ],
      },
      build: {
        // Vue 走 CDN，减小脚本体积
        externalGlobals: {
          vue: cdn.jsdelivr('Vue', 'dist/vue.global.prod.js'),
        },
      },
    }),
  ],
})

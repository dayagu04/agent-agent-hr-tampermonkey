// 油猴脚本入口 — 注入 Vue 悬浮面板到招聘平台页面
import { createApp } from 'vue'
import App from './App.vue'

function mount() {
  // 创建挂载容器（用 Shadow DOM 隔离样式，避免污染宿主页面 / 被宿主样式干扰）
  const host = document.createElement('div')
  host.id = 'aah-plugin-root'
  document.body.appendChild(host)

  // 注：为简化首版，直接挂在 body（样式用 .aah- 前缀避免冲突）。
  // 若遇宿主样式干扰，可改用 Shadow DOM。
  createApp(App).mount(host)
}

// 等页面加载完成再挂载（SPA 平台可能延迟渲染）
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(mount, 1000)
} else {
  window.addEventListener('load', () => setTimeout(mount, 1000))
}

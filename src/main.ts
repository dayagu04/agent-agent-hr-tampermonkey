// 油猴脚本入口 —— 注入 Vue 悬浮面板到招聘平台页面
import { createApp } from 'vue'
import App from './App.vue'

function mount() {
  // 创建挂载容器，直接挂在 body（样式用 .aah- 前缀避免与宿主冲突）
  const host = document.createElement('div')
  host.id = 'aah-plugin-root'
  document.body.appendChild(host)
  createApp(App).mount(host)
}

// 等页面加载完成再挂载（SPA 平台可能延迟渲染）
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(mount, 1000)
} else {
  window.addEventListener('load', () => setTimeout(mount, 1000))
}

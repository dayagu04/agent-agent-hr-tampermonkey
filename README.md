# 智能求职助手 — 社招自动投递油猴插件

基于匹配度模型，在招聘平台自动筛选投递岗位、托管 HR 会话的油猴（Tampermonkey）插件。

是 `agent-agent-hr` 主项目的子模块，复用主项目的匹配引擎（规则 + 语义 + LLM），
通过 `/api/plugin/*` HTTP 接口与后端通信；请求入口见 [src/api.ts](src/api.ts) 和 [src/remote.ts](src/remote.ts)。

## 功能

- **匹配度筛选投递**：扫描搜索页岗位 → 后端批量评分 → 按阈值与过滤规则（黑名单/最低薪资）筛选 → 拟人间隔逐个投递，实时标记每张卡片的结果。
- **智能编排**：决策由后端 LangGraph 统一完成，插件只按指令执行（搜索 → 逐页投递 → 定期回会话页自动回复），跨页持续运行直到目标达成，页面刷新自动恢复。
- **会话托管**：自动读取 HR 消息、交后端分类生成回复、页面内发送并回报结果；处理「索要简历」「工作地点确认」卡片，联系方式类卡片一律不自动同意。
- **HR 消息列表**：以 BOSS 页面 DOM 为真相源渲染会话列表，后端只做富化（内容摘要/时间/匹配分），低分/未评分会话标注跳过原因。
- **DOM 诊断**：日志 Tab 可采集页面真实 DOM 结构并导出，用于平台改版后的适配。

## 平台支持

| 平台 | 状态 |
|------|------|
| BOSS 直聘 | ✅ 主平台：投递 + 会话托管 + 智能编排全链路 |
| 智联招聘 | ✅ 列表页投递 |
| 51前程无忧 / 猎聘 | ⏸ 适配器预留（选择器未在真实页面验证，`@match` 未启用） |

## 安装

### 1. 安装 Tampermonkey

Chrome/Edge 安装 [Tampermonkey](https://www.tampermonkey.net/)，并在扩展详情里开启「开发者模式」和「允许用户脚本 / Allow user scripts on all sites」（Manifest V3 权限门槛，默认关闭会导致脚本静默失效）。

### 2. 安装脚本

**从 Release 安装（推荐）**：下载 [Releases](https://github.com/dayagu04/agent-agent-hr-tampermonkey/releases) 页最新的 `agent-agent-hr-tampermonkey.user.js`，拖入 Tampermonkey「添加新脚本」。脚本头带 `@updateURL`，新版本会自动提示更新。

**本地构建**：

```bash
npm install
npm run build
# 产物：dist/agent-agent-hr-tampermonkey.user.js，内容拖入 Tampermonkey
```

**开发热更新**：`npm run dev`，在油猴里安装 vite 提供的 install 链接，改代码自动更新。

## 配置与使用

打开任一支持平台的页面，右下角出现蓝色「投」悬浮球：

1. 设置 Tab：填后端地址 → 邮箱密码登录（或粘贴网页端 Token）→ 选简历 → 从网站同步求职偏好。
2. 调整匹配阈值、投递上限、投递间隔、会话托管回复阈值等。
3. 投递 Tab：在搜索结果页点「投当前页」只投本页；或配置目标与关键词后启动「智能编排」。
4. 会话 Tab：在 BOSS 聊天页点「开始会话托管」自动回复 HR；会话列表点击卡片可跳转打开对应会话。

卡片左边框颜色标记处理状态：绿 = 匹配通过，蓝 = 已投，灰 = 跳过，橙 = 失败，紫 = 待核对。

## 项目结构

```
tampermonkey-plugin/
├── vite.config.ts          # vite-plugin-monkey 配置（@match/@grant/版本）
├── src/
│   ├── main.ts             # 入口：注入 Vue 面板
│   ├── App.vue             # 悬浮面板 UI（投递/会话/设置/日志）
│   ├── api.ts              # 后端通信（统一走 platform-bridge 网络层）
│   ├── platform-bridge.ts  # GM API 隔离层（存储/网络/通知）
│   ├── engine.ts           # 投递引擎（扫描→过滤→匹配→投递→上报）
│   ├── orchestrator.ts     # 执行器（执行后端编排指令 + 事件上报 + 跨页恢复）
│   ├── remote.ts           # 网页端远程管理（心跳上报 + 命令轮询）
│   ├── chat-store.ts       # 会话低分判定缓存
│   ├── ledger.ts           # 会话本地镜像 + 岗位缓存
│   ├── dom-events.ts       # 合成点击工具（pointer+mouse 事件序列）
│   ├── domprobe.ts         # 通用 DOM 定位（文本/角色锚点）
│   ├── dom-collector.ts    # 结构化 DOM 采集
│   ├── logger.ts           # 页面内诊断日志（持久化 + 面板展示）
│   ├── search-filter.ts    # BOSS 搜索页筛选选项动态读取/应用
│   ├── config.ts / types.ts / version.ts
│   └── platforms/
│       ├── base.ts         # 平台抽象基类
│       ├── factory.ts      # URL → 平台实例
│       ├── boss.ts         # BOSS 投递
│       ├── boss-chat.ts    # BOSS 会话托管/删除
│       ├── boss-delete.ts  # BOSS 删除链路（行组件/列表菜单/头部菜单）
│       ├── boss-probe.ts   # BOSS 聊天页 DOM 采集
│       ├── zhaopin.ts / liepin.ts / qiancheng.ts
└── dist/                   # 构建产物（git 忽略）
```

## 开发

```bash
npm install        # 装依赖
npm run dev        # 开发模式（热更新）
npm run build      # 生产构建 → dist/*.user.js
npm run typecheck  # vue-tsc 类型检查
```

技术栈：Vue 3 + TypeScript + Vite + vite-plugin-monkey。

平台改版导致选择器失效时，用日志 Tab 的「采集当前页 / 聊天页结构」采集真实 DOM 并导出日志，再据实适配。

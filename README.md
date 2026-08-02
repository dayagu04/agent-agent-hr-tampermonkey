# 智能求职助手 — 社招自动投递油猴插件

基于匹配度模型，在招聘平台自动筛选并投递岗位的油猴（Tampermonkey）插件。

是 `agent-agent-hr` 主项目的子模块，复用主项目的匹配引擎（规则 + 语义 + LLM 三层融合）。

独立仓库：`github.com/dayagu04/agent-agent-hr-tampermonkey`（主项目以 submodule 方式引用，
后端 API 契约见 [API.md](./API.md)，插件与主项目通过 `/api/plugin/*` HTTP 接口解耦）。

## 🎯 当前状态 (v0.1 - 2026-06-27)

**✅ 已上线平台**（选择器已验证）：
- **智联招聘** - 全部选择器验证通过 (7/7)
- **51前程无忧** - 全部选择器验证通过 (7/7)

**⏸ 待启用平台**（需补充登录态验证）：
- BOSS直聘 - 代码已完成，待验证
- 猎聘 - 代码已完成，待验证

---

## 工作原理

```
用户在某平台职位搜索列表页
  ↓
插件注入悬浮面板（右下角"投"按钮）
  ↓
点「开始自动投递」
  ↓
1. 扫描当前页所有职位卡片（标题/公司/薪资/JD）
2. 提交后端 /api/plugin/match 计算匹配度（复用 MatchAgent）
3. 按阈值筛选（默认 ≥60 分）
4. 逐个点击平台投递按钮（拟人间隔防风控）
5. 投递成功上报 /api/plugin/record 记账
  ↓
面板实时显示进度（扫描/匹配/已投/跳过/失败）
```

**注**：本插件只做"投递"，不做 HR 聊天（主项目对话功能已下线）。BOSS 的「立即沟通」点击即视为投递完成，不发送消息。

---

## 安装

### 1. 安装 Tampermonkey 浏览器扩展
- Chrome/Edge：[Tampermonkey 商店](https://www.tampermonkey.net/)
- ⚠️ **关键步骤（Chrome/Edge Manifest V3 必需）**：安装后必须手动开启两个开关，否则脚本不会注入页面（悬浮球不出现）：
  1. 打开 `chrome://extensions/` 或 `edge://extensions/`
  2. 找到 Tampermonkey 卡片 → 点「详细信息」
  3. **开启「开发者模式」**（页面右上角总开关）
  4. **开启「允许访问文件网址」或「Allow access to file URLs」**（如需离线测试）
  5. **🔴 最重要：下滑找到「允许用户脚本 / Allow user scripts on all sites」，开启此开关**
     - 这是 Manifest V3 新增的权限门槛，默认关闭会导致用户脚本静默失效
     - 症状：Tampermonkey 显示脚本已启用，但页面上完全没反应

### 2. 安装本插件脚本
**方式 C：从 GitHub Release 安装（推荐正式使用）**
1. 打开本仓库的 [Releases](https://github.com/dayagu04/agent-agent-hr-tampermonkey/releases) 页面
2. 下载最新 `agent-agent-hr-tampermonkey.user.js`
3. 拖入 Tampermonkey「添加新脚本」

脚本头已带 `@updateURL`，新版本发布后 Tampermonkey 会自动提示更新。

**方式 A：本地构建（推荐开发用）**
```bash
cd tampermonkey-plugin
npm install
npm run build
# 生成 dist/agent-agent-hr-tampermonkey.user.js
```
然后把 `dist/*.user.js` 内容拖入 Tampermonkey 的「添加新脚本」。

**方式 B：开发热更新**
```bash
npm run dev
# 油猴里安装 vite 提供的 install 链接，改代码自动更新
```

### 3. 配置插件
打开任一支持平台的职位搜索页（如 `https://sou.zhaopin.com/?kw=Python`），右下角出现蓝色「投」悬浮球：
1. 点悬浮球 → 点 ⚙ 设置
2. **后端地址**：填写你的后端地址
   - 本地开发：`http://localhost:8010`
   - 生产环境：填写实际部署的域名或 IP
3. **登录方式**（二选一）：
   - **方式 A（推荐）**：直接在插件内填邮箱+密码登录，自动获取 Token 并拉取简历列表
   - **方式 B（备用）**：在网页端登录后，从浏览器开发者工具 Console 运行 `localStorage.token` 复制，粘贴到插件的 Token 输入框
4. 选择简历（下拉菜单）
5. 调整匹配阈值（默认 60）、投递上限（默认 20）、间隔（3-6 秒）
6. 返回主面板，点「开始自动投递」

---

## 各平台使用页面

| 平台 | 使用页面 | 投递交互 | 状态 |
|------|---------|---------|------|
| 智联招聘 | `sou.zhaopin.com` 搜索结果 | 「立即投递」按钮 | ✅ 已验证 |
| 51前程无忧 | `we.51job.com/pc/search` 搜索 | 「投递/申请职位」 | ✅ 已验证 |
| BOSS直聘 | `zhipin.com/web/geek/job` 搜索列表 | 点卡片→「立即沟通」 | ⏸ 待验证 |
| 猎聘 | `liepin.com/zhaopin/` 搜索列表 | 「投递简历」（可能需进详情页） | ⏸ 待验证 |

卡片左边框颜色标记处理状态：
- 🟢 绿色 = 匹配通过
- 🔵 蓝色 = 已投递
- ⚪ 灰色 = 低分跳过
- 🟠 橙色 = 投递失败/需手动

---

## 项目结构

```
tampermonkey-plugin/
├── vite.config.ts         # vite-plugin-monkey 配置（@match/@grant）
├── src/
│   ├── main.ts            # 入口：注入 Vue 面板
│   ├── App.vue            # 悬浮面板 UI（配置 + 进度）
│   ├── engine.ts          # 投递引擎（扫描→匹配→投递→上报）
│   ├── api.ts             # 后端通信（GM_xmlhttpRequest）
│   ├── config.ts          # 配置存储（GM_setValue）
│   ├── types.ts           # 类型定义
│   └── platforms/
│       ├── base.ts        # 平台抽象基类
│       ├── factory.ts     # URL → 平台实例
│       ├── boss.ts        # BOSS 直聘
│       ├── zhaopin.ts     # 智联招聘
│       ├── liepin.ts      # 猎聘
│       └── qiancheng.ts   # 51前程无忧
└── dist/                  # 构建产物 .user.js
```

---

## 后端 API 契约

插件调用主项目的 `/api/plugin/*` 端点（`server/routers/plugin.py`）：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/plugin/config` | GET | 拉取简历列表 + 默认阈值 |
| `/api/plugin/match` | POST | 批量计算岗位匹配度 |
| `/api/plugin/record` | POST | 记录一次投递（写 Application 表） |

鉴权：HTTP Header `Authorization: Bearer <JWT>`（复用主项目登录态）。

---

## ⚠️ 重要：DOM 选择器需真实环境验证

各平台的页面 DOM 结构（class 名、按钮位置）**会随平台改版变化**，且开发时无法访问真实登录态页面验证。各适配器中标注了 `// TODO[真实验证]` 的选择器**需在真实浏览器中调试确认**：

### 调试方法
1. 在目标平台搜索页打开浏览器开发者工具（F12）
2. 用元素检查器找到：
   - **职位卡片容器**（如 BOSS 的 `li.job-card-wrapper`）
   - **职位标题/公司/薪资** 的子选择器
   - **投递/沟通按钮** 的选择器
3. 对照 `src/platforms/<平台>.ts` 中的选择器，修正不匹配的部分
4. `npm run build` 重新构建，刷新页面测试

### 已知需重点验证的点
- **BOSS**：列表卡片是否需进详情页才有「立即沟通」；新版可能 hover 出按钮
- **智联/猎聘**：列表页是否有直接投递按钮，还是必须进详情页（详情页投递需跨页方案）
- **51**：是勾选 checkbox 批量投递，还是单卡片投递
- **猎聘**：投递可能要求选简历 + 强登录态

### 各平台投递差异说明
列表页直接投递的平台体验最好；需进详情页的平台（猎聘大概率、智联部分），首版会返回"失败/需手动"，标橙色。后续可增强为"新窗口注入 + 详情页投递"方案。

---

## 防风控建议
- 投递间隔默认 3-6 秒（拟人），不要调太短
- 单次投递上限默认 20，不要一次投太多
- 插件在你的真实浏览器运行，比服务端爬虫安全，但仍建议适度使用
- 各平台有每日投递上限，触达后会投递失败

---

## 开发

```bash
npm install        # 装依赖
npm run dev        # 开发模式（热更新）
npm run build      # 生产构建 → dist/*.user.js
```

技术栈：Vue 3 + TypeScript + Vite + vite-plugin-monkey。

# tools/

## 截图工具（UI 回归）

生成插件面板的回归截图，1366×768（项目声明支持的最小分辨率），16 张覆盖全部 Tab 与状态组合。

```bash
npm run build                      # 必须先构建：脚本注入的是 dist/ 产物，不是源码
C:/Python311/python.exe tools/shoot.py
# 输出到 docs/screenshots/
```

依赖：`playwright` + Chromium（`pip install playwright && playwright install chromium`）。

### 原理

Playwright 拦截 `https://www.zhipin.com/**` 的请求，改喂本地替身页
（`shot-harness.html`，一个模仿 BOSS 搜索页底色的静态骨架），再把**真实构建产物**
`dist/agent-agent-hr-tampermonkey.user.js` 注入进去运行。

因此：`location.href` 确实是 `zhipin.com`、`detectPlatform()` 走真实分支、执行的是真编译代码，
而不是另写一份 UI 复现。

替身页补齐了油猴 API 桩：

- `GM_getValue/GM_setValue/…` → 落 `localStorage`（前缀 `gm:`）。**不能用内存 Map**：GM 存储的
  语义是「跨页面重载持久」，用 Map 的话 `page.reload()` 重建 JS 上下文就全丢了。
- `GM_xmlhttpRequest` → 按端点返回合理形状的响应。**不能一律返 401**：面板会按真实逻辑判定
  Token 过期并清掉 `token`/`resumeId` 存盘，已配置态的截图会自己变成未配置态。

### 能验证 / 不能验证

| | |
|---|---|
| ✅ 适用 | 面板自身的渲染、布局尺寸、Tab 交互、响应式行为（含 resize 夹紧） |
| ❌ 不适用 | 与 BOSS 真实页面的集成——选择器命中、反爬/devtools 检测、Vue 事件委托、登录态 |

后者仍需装进 Tampermonkey 在真实环境验证，本工具替代不了。

### 脚本同时输出的实测数值

除截图外，`shoot.py` 会直接读 `boundingBox()` 打印关键尺寸并断言悬浮球夹紧结果，
避免靠目测判断布局是否正确：

```
面板实测宽度 = 562px（560 + 左右各 1px 边框）
左导航实测宽度 = 81px（80 + 1px 分隔线）
面板实测高度 = 583.6px（视口 768 → 70vh≈538 + 表头）
缩窗后 球 y=440（视口高 500）  球是否回到视口内: True
页面无 JS 报错
```

任何 `pageerror` 或 `console.error` 都会在末尾汇总列出。

### 加新截图

在 `shoot.py::shoot_all()` 里按现有模式加 `await snap(page, "17-xxx")`。
`snap(page, name, selector)` 的 `selector=None` 表示截整页（用于看悬浮球在视口中的位置），
默认截 `.aah-drawer`（只要面板本身）。

已配置态的种子数据在 `SEED_JS` 常量里。改动时注意字段名要与源码一致——例如
`aah_pending_greetings` 缺 `createdAt` 会被 `src/pending.ts` 的 TTL 过滤当过期条目丢掉，
提示就不出现（不是 UI 的 bug）。

### 临时目录

`tools/.shot-stage/` 是每次运行重建的暂存目录（替身页 + vue + 产物），已在 `.gitignore` 中。

---

## 真实页面注入验证（`real_shoot.py`）

```bash
npm run build
PYTHONIOENCODING=utf-8 C:/Python311/python.exe tools/real_shoot.py
# 输出到 docs/screenshots/real/
```

加载**真实** `www.zhipin.com`（未登录），注入构建产物，验证 4 项基础交互：
Tab 切换、齿轮跳设置并高亮、悬浮球拖拽、缩窗夹紧。每项都有断言，失败会汇总打印。

### 安全边界（有意为之，勿放宽）

- **不使用 `data/zhipin_profiles/` 里的登录态。** BOSS 有自动化检测，用真实求职账号跑
  Playwright 有被风控风险且不可逆。
- 只点面板自身的元素，绝不点 BOSS 的「立即沟通」「投递」，不触发任何投递动作。
- 种子配置 `autoResume:false`，避免挂载时恢复出跨页任务。
- **不绕过验证码。** 那属于反检测规避。

### 已知限制：安全验证墙

2026-07-31 实测：本机 IP 已被 BOSS 标记，`/`、`/shenzhen/`、`/web/geek/jobs`、`/job_detail/`
**全部** 302 到 `/web/passport/zp/verify.html`（「当前 IP 地址可能存在异常访问行为」，
职位卡片 0 个）。脚本会检测并明确打印命中墙页，不会把墙页当职位页糊过去。

所以它证明的是：面板在**真实 BOSS 下发的页面**（真 CSS/字体/页面脚本/CSP）里能注入、
不被宿主样式污染、四项交互正常、零报错。**不能**证明与职位列表 DOM 的集成
（选择器命中率）——那需要能过验证的浏览器，只能你本人手动测。

若哪天 IP 解封或换网络，脚本会自动打印 `✅ 真实职位列表已渲染`，那轮截图才含真实职位 DOM。

### 与 shoot.py 的分工

| | shoot.py | real_shoot.py |
|---|---|---|
| 页面 | 本地静态替身页 | 真实 zhipin.com |
| 产物 | 真实 dist/ | 真实 dist/ |
| 覆盖 | 17 张，全 Tab × 全状态 | 6 张，4 项基础交互 |
| 强项 | 布局尺寸、状态组合、可重复 | 真实宿主环境不冲突 |
| 盲区 | 真实 DOM 集成 | 状态组合少；受验证墙限制 |

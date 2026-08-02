"""油猴面板 UI 截图工具（Phase 2 验收用）。

做法：用 Playwright 拦截 https://www.zhipin.com/** 的请求，改喂本地替身页，
再把**真实构建产物** dist/*.user.js 注入进去跑。这样 detectPlatform() 读到的
location.href 确实是 zhipin.com，走的也是真编译代码，而不是另写一份复现。

局限（必须如实说明）：替身页只是静态骨架，不含 BOSS 的真实 DOM 与脚本，
故此法能验证「面板自身的渲染/布局/交互」，不能验证「与 BOSS 页面的集成」
（选择器命中、反爬、Vue 事件委托等）。

用法：C:\\Python311\\python.exe tools/shoot.py
"""
import asyncio
import json
import shutil
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
OUT = ROOT / "docs" / "screenshots"
# 搜索页 / 聊天页各截一组：面板在两处的分支不同
URL_SEARCH = "https://www.zhipin.com/web/geek/jobs?query=C%2B%2B&city=101280600"
URL_CHAT = "https://www.zhipin.com/web/geek/chat"

PANEL = ".aah-drawer"


def stage() -> Path:
    """把替身页 + vue + 构建产物拷到一个临时目录，作为被拦截请求的返回内容。"""
    d = TOOLS / ".shot-stage"
    d.mkdir(exist_ok=True)
    shutil.copy(TOOLS / "shot-harness.html", d / "index.html")
    shutil.copy(ROOT / "node_modules/vue/dist/vue.global.prod.js", d / "vue.global.prod.js")
    shutil.copy(
        ROOT / "dist/agent-agent-hr-tampermonkey.user.js", d / "bundle.user.js"
    )
    return d


# 已配置态的种子数据。写进 localStorage（GM 桩的后端），在页面脚本前注入，
# 这样面板首帧就是已配置态，不需要 reload（reload 会重建 JS 上下文）。
SEED_JS = """
(() => {
  const set = (k, v) => localStorage.setItem('gm:' + k, v)
  set('aah_plugin_config', JSON.stringify({
    apiBase: 'http://localhost:8010',
    token: 'demo.jwt.token', resumeId: 1, threshold: 65, maxApply: 10,
    delayMin: 8000, delayMax: 15000, autoPaginate: true, maxPages: 5,
    autoResume: true, prefCity: '深圳', rejectOffCityLocation: false,
  }))
  // 造几行诊断日志，避免日志 Tab 只显示"暂无日志"
  set('aah_diag_log', JSON.stringify([
    '[07-31 19:20:01][INIT] 插件已注入：平台=BOSS直聘 url=www.zhipin.com/web/geek/jobs',
    '[07-31 19:20:03][BOSS] 卡片命中 15 个',
    '[07-31 19:20:05][ENGINE] 匹配请求已发送（15 个岗位）',
    '[07-31 19:20:07][ENGINE] 匹配返回：8 个达标（阈值 65）',
    '[07-31 19:20:09][BOSS] 投递: C++开发工程师 @ 某某科技 (87分)',
    '[07-31 19:20:31][BOSS] 投递: Python后端开发 @ 某某网络 (81分)',
  ]))
  // 造两条待补发招呼语，让会话 Tab 的黄色提示出现。
  // 字段名与 createdAt 必须齐（见 src/pending.ts::PendingGreeting）：
  // 缺 createdAt 会被 TTL 过滤当成过期条目丢掉，提示就不出现。
  set('aah_pending_greetings', JSON.stringify([
    { platformJobId: 'j1', company: '某某科技', title: 'C++开发工程师',
      greeting: '你好，我对这个岗位很感兴趣', createdAt: Date.now() },
    { platformJobId: 'j2', company: '某某网络', title: 'Python后端开发',
      greeting: '你好，我对这个岗位很感兴趣', createdAt: Date.now() },
  ]))
})()
"""

# GET /api/conversations/list 的桩响应（两条 HR 消息：一未读一已读）。
#
# 为什么要桩：会话 Tab 的卡片现在走真接口，不桩的话本地 8010 端口没人监听，
# 面板只会显示"加载失败"，截不到卡片样式。字段名必须与后端
# server/routers/conversations.py::list_conversations 的返回一致。
HR_LIST_STUB = {
    "conversations": [
        {
            "id": 101,
            "application_id": 11,
            "company": "图迅电子",
            "job_title": "C++ 开发工程师",
            "platform": "zhipin",
            "status": "active",
            "last_message_at": "2026-07-31T19:20:00",
            "message_count": 3,
            "unread_count": 1,
            # intent 为空 → 前端判为未读（蓝条卡片）
            "last_hr_message": {
                "id": 9001,
                "content": "你好，看到你的简历挺合适的，方便发一份最新的过来吗？",
                "truncated": False,
                "intent": None,
                "created_at": "2026-07-31T19:20:00",
            },
        },
        {
            "id": 102,
            "application_id": 12,
            "company": "某某网络技术",
            "job_title": "Python 后端开发",
            "platform": "zhipin",
            "status": "active",
            "last_message_at": "2026-07-31T15:05:00",
            "message_count": 6,
            "unread_count": 0,
            "last_hr_message": {
                "id": 9002,
                "content": "我们这边周三下午方便安排一轮线上面试，你时间可以吗？",
                "truncated": False,
                "intent": "schedule_interview",
                "created_at": "2026-07-31T15:05:00",
            },
        },
    ]
}


async def new_ctx(
    browser, d, errors, seed: bool, width=1366, height=768, hr_list=None,
    reduced_motion=None,
):
    """建一个上下文：拦截 zhipin.com → 喂替身页；seed=True 时预置已配置态。

    hr_list: /api/conversations/list 的桩响应。传 None 用默认两条；
             传 {"conversations": []} 可截空态。
    reduced_motion: 传 "reduce" 模拟系统「减少动画」偏好，用于验证过渡被关掉。
    """
    types = {".html": "text/html", ".js": "application/javascript"}
    opts = {"viewport": {"width": width, "height": height}}
    if reduced_motion:
        opts["reduced_motion"] = reduced_motion
    ctx = await browser.new_context(**opts)

    # 后端接口桩。GM_xmlhttpRequest 在桩里走 fetch（见 shot-harness.html），
    # 所以能被 Playwright 的 route 拦到。
    payload = HR_LIST_STUB if hr_list is None else hr_list

    async def api_route(r):
        await r.fulfill(
            status=200,
            body=json.dumps(payload, ensure_ascii=False),
            headers={"content-type": "application/json; charset=utf-8"},
        )

    await ctx.route("**/api/conversations/list*", api_route)

    async def route(r):
        path = r.request.url.split("?")[0].rsplit("/", 1)[-1]
        f = d / (path if path.endswith(".js") else "index.html")
        if not f.exists():
            await r.fulfill(status=404, body="")
            return
        suffix = ".js" if f.suffix == ".js" else ".html"
        await r.fulfill(
            status=200,
            body=f.read_bytes(),
            headers={"content-type": types[suffix] + "; charset=utf-8"},
        )

    await ctx.route("https://www.zhipin.com/**", route)
    if seed:
        await ctx.add_init_script(SEED_JS)

    page = await ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on(
        "console",
        lambda m: errors.append(f"console.{m.type}: {m.text}")
        if m.type == "error"
        else None,
    )
    return ctx, page


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    d = stage()
    errors: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        await shoot_all(browser, d, errors)
        await browser.close()

    if errors:
        print("\n!! 页面报错（需排查）:")
        for e in errors[:20]:
            print("   ", e)
    else:
        print("\n页面无 JS 报错")


async def open_panel(page) -> None:
    """点悬浮球展开面板（main.ts 里 mount 延迟 1s，需等球出现）。"""
    await page.wait_for_selector(".aah-ball", timeout=15000)
    await page.click(".aah-ball")
    await page.wait_for_selector(PANEL, timeout=5000)


async def snap(page, name: str, selector: str | None = PANEL) -> None:
    """截图。selector=None 截整页（用于看悬浮球在视口里的位置）。"""
    # 420ms：Tab 切换是 mode="out-in"，淡出 150 + 淡入 150 = 300ms；抽屉 slide 220ms。
    # 取两者上界再留余量。原先 250ms 是在加过渡之前定的，现在会截到半透明的 pane。
    await page.wait_for_timeout(420)
    target = page.locator(selector) if selector else page
    await target.screenshot(path=str(OUT / f"{name}.png"))
    print(f"  已保存 {name}.png")


async def shoot_all(browser, d, errors: list[str]) -> None:
    # ===== 未配置态：四个 Tab =====
    print("搜索页 · 未配置态（1366x768）:")
    ctx0, page = await new_ctx(browser, d, errors, seed=False)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    await snap(page, "01-apply-unconfigured")

    for idx, (key, label) in enumerate(
        [("chat", "会话"), ("settings", "设置"), ("logs", "日志")], start=2
    ):
        await page.click(f".aah-tab:has-text('{label}')")
        await snap(page, f"0{idx}-tab-{key}-unconfigured")
    await ctx0.close()

    # ===== 已配置态：另开上下文，种子在页面脚本前注入 =====
    print("搜索页 · 已配置态:")
    ctx1, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    await snap(page, "05-apply-configured")

    for idx, (key, label) in enumerate(
        [("chat", "会话"), ("settings", "设置"), ("logs", "日志")], start=6
    ):
        await page.click(f".aah-tab:has-text('{label}')")
        await snap(page, f"0{idx}-tab-{key}-configured")

    # ⚙ 高亮：设置 Tab 已激活时截表头
    await page.click(".aah-tab:has-text('设置')")
    await snap(page, "09-header-gear-active", ".aah-header")
    # 对照组：切到投递 Tab，⚙ 应回到半透明态
    await page.click(".aah-tab:has-text('投递')")
    await snap(page, "10-header-gear-inactive", ".aah-header")

    # 展开日志 Tab 的调试折叠项，确认入口已迁来
    await page.click(".aah-tab:has-text('日志')")
    await page.click(".aah-advanced > summary")
    await snap(page, "11-logs-debug-expanded")

    # ===== 560px 宽度 + 整页观感 =====
    box = await page.locator(PANEL).bounding_box()
    print(f"  面板实测宽度 = {box['width']}px（期望 560）")
    tabs = await page.locator(".aah-tab-nav").bounding_box()
    print(f"  左导航实测宽度 = {tabs['width']}px（期望 80）")
    content = await page.locator(".aah-tab-content").bounding_box()
    print(f"  内容区实测宽度 = {content['width']}px（期望 ~478，含 1px 边框）")
    print(f"  面板实测高度 = {box['height']}px（视口 768 → 70vh≈538 + 表头）")
    await snap(page, "12-fullpage-on-boss", None)

    # ===== 聊天页：会话 Tab 应出现"开始会话托管"按钮 =====
    print("聊天页:")
    await page.goto(URL_CHAT)
    await open_panel(page)
    await page.click(".aah-tab:has-text('会话')")
    await snap(page, "13-chat-tab-on-chatpage")
    await page.click(".aah-tab:has-text('投递')")
    await snap(page, "14-apply-tab-on-chatpage")
    await ctx1.close()

    # ===== 非聊天页的会话 Tab：应出现「跳转到聊天页」按钮 =====
    print("非聊天页 · 跳转按钮:")
    ctx3, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    await page.click(".aah-tab:has-text('会话')")
    btn = page.locator(".aah-btn-secondary:has-text('跳转到聊天页')")
    # 必须显式等：Tab 切换是 mode="out-in" 过渡，旧 pane 先淡出 150ms 新 pane 才挂载。
    # 裸 is_visible() 在点击后立刻求值，那一刻新 pane 还不在 DOM 里，恒为 False。
    try:
        await btn.wait_for(state="visible", timeout=5000)
        print("  跳转按钮可见: True")
    except Exception:
        print("  跳转按钮可见: False")
        errors.append("非聊天页的会话 Tab 未显示「跳转到聊天页」按钮")
    await snap(page, "17-chat-tab-goto-button")
    # 点一下，确认真的导航到聊天页（而非静默失败）
    await btn.click()
    await page.wait_for_url("**/web/geek/chat", timeout=8000)
    print(f"  点击后 URL = {page.url}")
    await ctx3.close()

    # ===== 会话 Tab：真数据卡片（Phase 3）=====
    print("HR 消息卡片（真数据）:")
    ctx4, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_CHAT)
    await open_panel(page)
    await page.click(".aah-tab:has-text('会话')")
    cards = page.locator(".aah-hr-message")
    try:
        await cards.first.wait_for(timeout=8000)
    except Exception:
        errors.append("会话 Tab 未渲染出 HR 消息卡片（真数据链路可能断了）")
    n = await cards.count()
    print(f"  卡片数 = {n}（期望 2）")
    if n != 2:
        errors.append(f"HR 卡片数 {n} != 2")
    # 样例卡片必须已删除
    if await page.locator("text=以上为样例卡片").count():
        errors.append("样例卡片标注仍在")
    if await page.locator("text=示例科技有限公司").count():
        errors.append("占位样例数据仍在渲染")
    # 未读态：第一条 intent 为空 → 应带 unread class
    if not await page.locator(".aah-hr-message.unread").count():
        errors.append("未读卡片未标记 unread")
    await snap(page, "18-hr-cards-real")

    # 点卡片 → 已在聊天页，应就地切换（不跳转），并给出反馈文案
    await cards.first.click()
    await page.wait_for_timeout(600)
    print(f"  点击后 URL = {page.url}（应仍在 chat）")
    if "/web/geek/chat" not in page.url:
        errors.append("已在聊天页时点卡片却发生了跳转")
    await snap(page, "19-hr-card-clicked")
    await ctx4.close()

    # ===== 会话 Tab：空态（无任何 HR 回复）=====
    print("HR 消息空态:")
    ctx5, page = await new_ctx(
        browser, d, errors, seed=True, hr_list={"conversations": []}
    )
    await page.goto(URL_CHAT)
    await open_panel(page)
    await page.click(".aah-tab:has-text('会话')")
    empty = page.locator("text=暂无 HR 回复")
    try:
        await empty.wait_for(timeout=8000)
        print("  空态文案已出现")
    except Exception:
        errors.append("无 HR 消息时未显示「暂无 HR 回复」空态")
    await snap(page, "20-hr-cards-empty")
    await ctx5.close()

    # ===== 跨页打开会话：搜索页点卡片 → 跳转 + 交接单被消费 =====
    print("跨页打开会话:")
    ctx6, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    await page.click(".aah-tab:has-text('会话')")
    card = page.locator(".aah-hr-message").first
    try:
        await card.wait_for(timeout=8000)
        await card.click()
        await page.wait_for_url("**/web/geek/chat", timeout=8000)
        print(f"  跳转后 URL = {page.url}")
        # 交接单应被消费掉（一次性），否则下次进聊天页会重复触发
        await page.wait_for_timeout(1500)
        left = await page.evaluate(
            "() => localStorage.getItem('gm:aah_pending_open_thread')"
        )
        print(f"  交接单残留 = {left}")
        if left not in (None, "null", ""):
            errors.append(f"跨页交接单未被消费: {left}")
    except Exception as e:
        errors.append(f"跨页打开会话流程失败: {e}")
    # 跳转后是新的 JS 上下文，面板回到折叠态 —— 要重新展开才截得到
    await open_panel(page)
    await page.click(".aah-tab:has-text('会话')")
    await snap(page, "21-cross-page-open")
    await ctx6.close()

    # ===== 悬浮球缩窗夹紧 =====
    print("悬浮球夹紧:")
    ctx2, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await page.wait_for_selector(".aah-ball", timeout=15000)
    # 先把球拖到底部（模拟用户放在下方）
    ball = page.locator(".aah-ball")
    b = await ball.bounding_box()
    await page.mouse.move(b["x"] + 24, b["y"] + 24)
    await page.mouse.down()
    await page.mouse.move(b["x"] + 24, 700, steps=10)
    await page.mouse.up()
    await page.wait_for_timeout(300)
    before = await ball.bounding_box()
    print(f"  缩窗前 球 y={before['y']:.0f}（视口高 768）")
    await snap(page, "15-ball-before-resize", None)

    # 缩到 500 高：球原位置 y≈700 已在视口外，夹紧后应被拉回
    await page.set_viewport_size({"width": 900, "height": 500})
    await page.wait_for_timeout(700)  # 等 200ms 防抖 + 余量
    after = await ball.bounding_box()
    print(f"  缩窗后 球 y={after['y']:.0f}（视口高 500，应 <= 440）")
    in_view = after["y"] + after["height"] <= 500
    print(f"  球是否回到视口内: {in_view}")
    if not in_view:
        errors.append(f"悬浮球未被夹回视口：y={after['y']}")
    await snap(page, "16-ball-after-resize", None)
    await ctx2.close()

    # ===== Phase 4: 设置 Tab 两列栅格 =====
    # 断言方式是读 offsetTop 分组：同一行的字段 top 相同。只截图看不出
    # grid-column 有没有生效（半列字段恰好也可能因内容短而看着像并排）。
    print("设置两列栅格:")
    ctx7, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    await page.click(".aah-tab:has-text('设置')")
    await page.wait_for_selector(".aah-form-grid", timeout=8000)
    try:
        rows = await page.evaluate(
            """() => {
              const grid = document.querySelector('.aah-form-grid')
              const gridW = grid.getBoundingClientRect().width
              const items = [...grid.children].filter(el => el.offsetParent !== null)
              return items.map(el => {
                const r = el.getBoundingClientRect()
                const label = el.querySelector(':scope > span')?.textContent?.trim()
                  || el.textContent.trim().slice(0, 18)
                return {
                  label,
                  top: Math.round(r.top),
                  // 占宽比例 > 0.9 视为整行；两列时每列约 0.48
                  wideRatio: +(r.width / gridW).toFixed(2),
                  wide: el.classList.contains('aah-field-wide'),
                  tag: el.tagName.toLowerCase(),
                }
              })
            }"""
        )
        # 按 top 分组 → 每组就是一行
        by_top: dict[int, list[dict]] = {}
        for it in rows:
            by_top.setdefault(it["top"], []).append(it)
        two_col_rows = [v for v in by_top.values() if len(v) == 2]
        print(f"  栅格项 {len(rows)} 个，行数 {len(by_top)}，其中两列行 {len(two_col_rows)}")
        for v in two_col_rows:
            print(f"    并排: {v[0]['label']} | {v[1]['label']}")

        # 复合字段「投递间隔」必须整行
        interval = next((r for r in rows if "投递间隔" in (r["label"] or "")), None)
        if not interval:
            errors.append("设置页找不到「投递间隔」字段")
        elif interval["wideRatio"] < 0.9:
            errors.append(f"「投递间隔」未跨整行：占宽比 {interval['wideRatio']}")
        else:
            print(f"  ✓ 投递间隔跨整行（占宽比 {interval['wideRatio']}）")

        # 登录表单整块单列：邮箱/密码各占整行，不能与别的字段并排
        for key in ("邮箱", "密码"):
            f = next((r for r in rows if key in (r["label"] or "")), None)
            if f and f["wideRatio"] < 0.9:
                errors.append(f"登录字段「{key}」被拆成半列：占宽比 {f['wideRatio']}")
        print("  ✓ 登录表单未被拆列")

        # 至少要真出现一行两列，否则栅格等于没生效
        if not two_col_rows:
            errors.append("设置页没有任何两列并排行，栅格未生效")
    except Exception as e:
        errors.append(f"设置栅格断言失败: {e}")
    await snap(page, "22-settings-two-col")

    # 关掉自动翻页 → 「最多翻页数」消失，「单次最多投递」应自动铺满整行，
    # 否则它独占半列、右边空一块。这个组合最容易被漏掉：默认开着，看不到。
    try:
        cb = page.locator(".aah-field:has-text('自动翻页') input[type=checkbox]")
        await cb.uncheck()
        await page.wait_for_timeout(300)
        w = await page.evaluate(
            """() => {
              const g = document.querySelector('.aah-form-grid')
              const f = [...g.children].find(e =>
                e.offsetParent && e.textContent.includes('单次最多投递'))
              return +(f.getBoundingClientRect().width /
                       g.getBoundingClientRect().width).toFixed(2)
            }"""
        )
        print(f"  关自动翻页后「单次最多投递」占宽比 = {w}")
        if w < 0.9:
            errors.append(f"关掉自动翻页后「单次最多投递」未铺满整行：占宽比 {w}")
        else:
            print("  ✓ 落单的数字字段自动铺满整行")
        await snap(page, "26-settings-no-paginate")
        await cb.check()  # 复原，避免影响后续（同 ctx 不再用，但保持无副作用）
    except Exception as e:
        errors.append(f"落单字段铺满断言失败: {e}")
    await ctx7.close()

    # ===== Phase 4: 当前岗位卡片进度条 =====
    # 直接注入 progress 状态不可行（Vue 内部状态），改用 config.maxApply 当分母：
    # 未启编排器时分母就是它，投递中 progress.applied 是分子。
    print("岗位卡片进度条:")
    ctx8, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    await page.click(".aah-tab:has-text('投递')")
    try:
        # 替身页的卡片是 .fake-card，与 BOSS 真实的 .job-card-wrap 不同形，
        # 扫描器扫不到 → 真投递流程跑不起来 → currentJob 永远是 null。
        # 改为注入一个与组件同结构的卡片，验证 CSS 契约（4px 宽 / 贴底 / .3s）。
        # 这验证不了 Vue 的分子分母计算 —— 那部分由下面的 progressTarget 纯函数断言覆盖。
        await page.evaluate(
            """() => {
              const pane = document.querySelector('.aah-tab-pane')
              const card = document.createElement('div')
              card.className = 'aah-current-job'
              card.innerHTML = `
                <div class="aah-job-progress" role="progressbar"
                     aria-valuenow="4" aria-valuemin="0" aria-valuemax="10">
                  <div class="aah-job-progress-fill" style="height:40%"></div>
                </div>
                <div class="aah-current-job-body">
                  <div class="aah-current-job-title">正在投递
                    <span class="aah-job-progress-text">4/10</span></div>
                  <div class="aah-current-job-content">
                    <div class="aah-job-name">C++ 开发工程师</div>
                    <div class="aah-job-company">@ 某某科技</div>
                    <div class="aah-job-score">匹配分 82</div>
                  </div>
                </div>`
              pane.insertBefore(card, pane.firstChild)
            }"""
        )
        await page.wait_for_timeout(400)  # 等 height 过渡落定
        bar = await page.evaluate(
            """() => {
              const card = document.querySelector('.aah-current-job')
              if (!card) return {noCard: true}
              const track = card.querySelector('.aah-job-progress')
              if (!track) return {noTrack: true}
              const fill = track.querySelector('.aah-job-progress-fill')
              const tr = track.getBoundingClientRect(), fr = fill.getBoundingClientRect()
              const cs = getComputedStyle(fill)
              return {
                trackW: Math.round(tr.width),
                // 填充块底边应与轨道底边对齐（自下而上）
                bottomAligned: Math.abs(tr.bottom - fr.bottom) <= 1,
                fillH: Math.round(fr.height), trackH: Math.round(tr.height),
                transition: cs.transitionProperty + ' ' + cs.transitionDuration,
                role: track.getAttribute('role'),
                now: track.getAttribute('aria-valuenow'),
                max: track.getAttribute('aria-valuemax'),
                text: card.querySelector('.aah-job-progress-text')?.textContent?.trim(),
              }
            }"""
        )
        print(f"  {bar}")
        if bar.get("noCard"):
            errors.append("注入的岗位卡片未出现在 DOM 中")
        elif bar.get("noTrack"):
            errors.append("岗位卡片没有进度条元素")
        else:
            if bar["trackW"] != 4:
                errors.append(f"进度条宽度不是 4px：{bar['trackW']}px")
            if not bar["bottomAligned"]:
                errors.append("进度条填充未贴底（应自下而上填充）")
            if "0.3s" not in bar["transition"]:
                errors.append(f"进度条缺 .3s 过渡：{bar['transition']}")
            if bar["role"] != "progressbar":
                errors.append(f"进度条 role 不是 progressbar：{bar['role']}")
            print(
                f"  ✓ 4px 宽 / 贴底填充 / {bar['transition']} / "
                f"role={bar['role']} {bar['now']}/{bar['max']}"
            )
            # 高度应等于 aria 值算出的比例（4/10 = 40%），验证"贴底 + 按比例"两件事一致
            expect_h = round(bar["trackH"] * 0.4)
            if abs(bar["fillH"] - expect_h) > 2:
                errors.append(
                    f"填充高度与 4/10 不符：实测 {bar['fillH']}px，期望约 {expect_h}px"
                    f"（轨道 {bar['trackH']}px）"
                )
            else:
                print(f"  ✓ 填充高度 {bar['fillH']}/{bar['trackH']}px ≈ 40%")
        await snap(page, "23-job-progress-bar")
    except Exception as e:
        errors.append(f"进度条断言失败: {e}")

    # 分母取值逻辑：未启编排器时分母必须是 config.maxApply（seed 里是 10）。
    # 这条是真在跑的 Vue 计算，不是注入的静态 DOM —— 改设置页的值，看进度条上限跟不跟。
    try:
        await page.click(".aah-tab:has-text('设置')")
        await page.wait_for_selector(".aah-form-grid", timeout=8000)
        maxapply = page.locator(".aah-field:has-text('单次最多投递') input")
        await maxapply.fill("7")
        await maxapply.dispatch_event("change")
        await page.wait_for_timeout(300)
        saved = await page.evaluate(
            "() => JSON.parse(localStorage.getItem('gm:aah_plugin_config') || '{}').maxApply"
        )
        print(f"  改 maxApply=7 后已持久化 = {saved}")
        if saved != 7:
            errors.append(f"maxApply 未持久化：读回 {saved}")
        else:
            print("  ✓ 分母来源 config.maxApply 可被设置页驱动")
    except Exception as e:
        errors.append(f"分母来源断言失败: {e}")
    await ctx8.close()

    # ===== Phase 4: Tab 淡入 + 抽屉 slide =====
    # 过渡类是瞬时的，靠事件监听抓：MutationObserver 记录 class 出现过没有。
    print("过渡动画:")
    ctx9, page = await new_ctx(browser, d, errors, seed=True)
    await page.goto(URL_SEARCH)
    await open_panel(page)
    try:
        await page.evaluate(
            """() => {
              window.__seen = new Set()
              const root = document.querySelector('.aah-root')
              new MutationObserver(muts => {
                for (const m of muts) {
                  const cl = m.target.className
                  if (typeof cl !== 'string') continue
                  for (const c of cl.split(/\\s+/)) {
                    if (c.startsWith('aah-fade-') || c.startsWith('aah-slide-')) {
                      window.__seen.add(c)
                    }
                  }
                }
              }).observe(root, {attributes: true, attributeFilter: ['class'], subtree: true})
            }"""
        )
        # 切 Tab → 应触发 fade
        await page.click(".aah-tab:has-text('会话')")
        await page.wait_for_timeout(400)
        await page.click(".aah-tab:has-text('投递')")
        await page.wait_for_timeout(400)
        # 收起 → slide-leave
        await page.click('.aah-icon-btn[title="收起"]')
        await page.wait_for_timeout(400)
        # 再展开 → slide-enter。必须两个方向都测：只测收起时 enter 规则写错也不会报，
        # 而"打开抽屉"才是用户每次都看到的那一下。
        await page.click(".aah-ball")
        await page.wait_for_timeout(500)
        seen = await page.evaluate("() => [...window.__seen].sort()")
        print(f"  捕获过渡类: {seen}")
        if not any(c.startswith("aah-fade-") for c in seen):
            errors.append(f"Tab 切换未触发淡入淡出过渡，仅捕获 {seen}")
        else:
            print("  ✓ Tab fade 过渡已触发")
        for direction, label in (("leave", "收起"), ("enter", "展开")):
            if not any(c.startswith(f"aah-slide-{direction}") for c in seen):
                errors.append(f"抽屉{label}未触发 slide 过渡，仅捕获 {seen}")
            else:
                print(f"  ✓ 抽屉 {direction}（{label}）过渡已触发")
        # 时长按 CSS 声明核对（150ms fade / 220-180ms slide）
        durs = await page.evaluate(
            """() => {
              const out = {}
              for (const sheet of document.styleSheets) {
                let rules; try { rules = sheet.cssRules } catch { continue }
                for (const r of rules || []) {
                  if (!r.selectorText) continue
                  if (/aah-(fade|slide)-(enter|leave)-active/.test(r.selectorText)) {
                    out[r.selectorText] = r.style.transitionDuration
                  }
                }
              }
              return out
            }"""
        )
        print(f"  过渡时长: {durs}")
        fade = next((v for k, v in durs.items() if "fade" in k), "")
        if "0.15s" not in fade:
            errors.append(f"Tab fade 时长不是 150ms：{fade or '未找到规则'}")
    except Exception as e:
        errors.append(f"过渡动画断言失败: {e}")
    await snap(page, "24-transitions", None)
    await ctx9.close()

    # ===== Phase 4: prefers-reduced-motion 关掉动画 =====
    # 用 Playwright 的 reduced_motion 模拟系统偏好，直接读计算样式。
    # 这条不靠截图 —— 动画关没关在静态图上完全看不出来。
    print("减少动画偏好:")
    ctx10, page = await new_ctx(browser, d, errors, seed=True, reduced_motion="reduce")
    await page.goto(URL_SEARCH)
    await open_panel(page)
    try:
        await page.click(".aah-tab:has-text('会话')")
        await page.wait_for_timeout(400)
        got = await page.evaluate(
            """() => {
              const q = matchMedia('(prefers-reduced-motion: reduce)').matches
              const pane = document.querySelector('.aah-tab-pane')
              // 取一个带 transition 的元素实测计算值
              const tab = document.querySelector('.aah-tab')
              return {matched: q, paneTd: getComputedStyle(pane).transitionDuration,
                      tabTd: getComputedStyle(tab).transitionDuration}
            }"""
        )
        print(f"  媒体查询命中={got['matched']} pane 过渡={got['paneTd']}")
        if not got["matched"]:
            errors.append("reduced_motion 未生效，本条断言无意义")
        await snap(page, "25-reduced-motion")
    except Exception as e:
        errors.append(f"减少动画断言失败: {e}")
    await ctx10.close()


if __name__ == "__main__":
    asyncio.run(main())

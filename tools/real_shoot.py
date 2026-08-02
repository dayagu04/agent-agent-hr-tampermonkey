"""在**真实** www.zhipin.com 页面上验证面板交互（未登录态）。

与 shoot.py 的区别：shoot.py 喂的是本地静态替身页；本脚本加载真实 BOSS 页面，
把构建产物注入进去跑。因此能验证「面板与真实 BOSS DOM/CSS/页面脚本是否冲突」——
这是替身页证明不了的那部分。

⚠ 实测结论（2026-07-31）：本机 IP 已被 BOSS 标记，`/`、`/shenzhen/`、
`/web/geek/jobs`、`/job_detail/` **全部**返回「安全验证 - 当前 IP 地址可能存在
异常访问行为」墙页（body 仅 101 字，职位卡片 0 个）。所以本脚本实际截到的是
**真实 zhipin.com 域下的验证墙页**，不是职位列表页。

这仍有价值：页面由 BOSS 真实下发（真实 CSS/字体/页面脚本/CSP），能证明面板注入
不被拦、样式不被宿主污染、交互正常。但**不能**证明与职位列表 DOM 的集成
（选择器命中率等）——那需要能过验证的真实浏览器。

绕过验证码属于「反检测规避」，不做。若要在真实职位页截图，需你本人在已登录、
未被风控的浏览器里手动装 Tampermonkey 操作。

安全边界（有意为之，勿放宽）：
  * 不使用 data/zhipin_profiles/ 里的任何登录态。BOSS 有自动化检测，用真实求职
    账号跑 Playwright 有被风控的风险，且不可逆。故本脚本全程**未登录**。
  * 只点击面板自身的元素（Tab / ⚙ / 拖球）。绝不点 BOSS 的「立即沟通」「投递」
    等按钮，不触发任何投递动作。
  * 种子配置里 autoResume=false，避免挂载时恢复出一个跨页任务。

仍不能替代的：登录态下的真机手测（会话列表、招呼语发送等需登录才能验证）。

用法：npm run build && C:/Python311/python.exe tools/real_shoot.py
"""
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots" / "real"
URL = "https://www.zhipin.com/web/geek/jobs?query=C%2B%2B&city=101280600"

# GM 桩 + 未登录态下也能让面板显示完整 UI 的种子配置。
# autoResume:false —— 不恢复跨页任务，避免任何自动动作。
STUBS = """
(() => {
  const GK = (k) => 'gm:' + k
  window.GM_getValue = (k, d) => {
    const v = localStorage.getItem(GK(k)); return v === null ? d : v
  }
  window.GM_setValue = (k, v) => { localStorage.setItem(GK(k), String(v)) }
  window.GM_deleteValue = (k) => { localStorage.removeItem(GK(k)) }
  window.GM_listValues = () =>
    Object.keys(localStorage).filter((k) => k.startsWith('gm:')).map((k) => k.slice(3))
  // add_init_script 在文档解析前就跑，此时 document.head 还是 null，
  // 直接 head.append 会抛 "Cannot read properties of null"。真油猴的
  // GM_addStyle 自己处理了这个时机，故这是桩的问题、不是产物的问题。
  window.GM_addStyle = (css) => {
    const inject = () => {
      const s = document.createElement('style')
      s.textContent = css
      ;(document.head || document.documentElement).append(s)
    }
    if (document.head) inject()
    else document.addEventListener('DOMContentLoaded', inject, { once: true })
  }
  window.GM_notification = () => {}
  window.GM_xmlhttpRequest = (o) => {
    let body = '{}'
    if (String(o.url || '').includes('/api/plugin/config')) {
      body = JSON.stringify({
        resumes: [{ id: 1, name: '后端开发-张三.pdf', skills_count: 27 }],
        default_threshold: 60,
        supported_platforms: ['zhipin'],
        preferences: { keyword: 'C++', city: '深圳', threshold: 65, apply_limit: 10 },
      })
    }
    setTimeout(() => o.onload && o.onload({ status: 200, responseText: body }), 10)
  }
  localStorage.setItem(GK('aah_plugin_config'), JSON.stringify({
    apiBase: 'http://localhost:8010', token: 'demo.jwt.token', resumeId: 1,
    threshold: 65, maxApply: 10, delayMin: 8000, delayMax: 15000,
    autoPaginate: true, maxPages: 5,
    autoResume: false,  // 关键：不恢复任务，杜绝自动投递
    prefCity: '深圳', rejectOffCityLocation: false,
  }))
})()
"""


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    vue_src = (ROOT / "node_modules/vue/dist/vue.global.prod.js").read_text(encoding="utf-8")
    bundle = (ROOT / "dist/agent-agent-hr-tampermonkey.user.js").read_text(encoding="utf-8")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            args=["--disable-blink-features=AutomationControlled"]
        )
        ctx = await browser.new_context(
            viewport={"width": 1366, "height": 768},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
            locale="zh-CN",
        )
        # navigator.webdriver 是最常见的自动化指纹，抹掉以免被挡在 bot 墙外
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        # 顺序要紧：GM 桩 → Vue → 产物（产物顶层就调 GM_addStyle，且结尾 })(Vue)）。
        # Vue 的 global 版是 `var Vue=function(){...}()`，靠 <script> 顶层的 var
        # 变成全局；而 add_init_script 会把代码包进函数，var 就成了函数局部变量，
        # 产物结尾的 })(Vue) 便报 "Vue is not defined"。故显式挂到 window。
        await ctx.add_init_script(STUBS)
        await ctx.add_init_script(vue_src + "\n;window.Vue = Vue;")
        await ctx.add_init_script(bundle)

        errors: list[str] = []
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on(
            "console",
            lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None,
        )

        print(f"加载真实页面 {URL}")
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(2500)
        print(f"  实际 URL = {page.url}")
        print(f"  标题     = {await page.title()}")

        # 明确区分「真实职位页」与「真实验证墙页」——两者都是真 zhipin.com，
        # 但能证明的东西完全不同。不检测的话会误以为截到了职位页。
        body = await page.inner_text("body")
        cards = await page.locator(".job-card-wrapper, li.job-card-box").count()
        walled = ("安全验证" in body) or ("异常访问" in body)
        print(f"  职位卡片数 = {cards}")
        if walled:
            print("  ⚠ 命中 BOSS 安全验证墙（IP 被标记）：以下截图为验证墙页，")
            print("    可验证注入/样式/交互，但无法验证与职位列表 DOM 的集成。")
        elif cards == 0:
            print("  ⚠ 未命中墙但也无职位卡片：可能未登录或选择器已变。")
        else:
            print("  ✅ 真实职位列表已渲染，本轮截图含真实职位 DOM。")

        try:
            await page.wait_for_selector(".aah-ball", timeout=25000)
        except Exception:
            await page.screenshot(path=str(OUT / "00-FAILED-no-ball.png"), full_page=False)
            print("  !! 面板未注入成功，已存 00-FAILED-no-ball.png")
            for e in errors[:10]:
                print("    ", e)
            await browser.close()
            return
        print("  面板已注入（.aah-ball 出现）")

        # 真实页面上 BOSS 自己的报错与我们无关，只挑含 aah 的
        await shots(page, errors)
        await browser.close()

    ours = [e for e in errors if "aah" in e.lower()]
    print(f"\n本插件相关报错: {len(ours)}")
    for e in ours[:10]:
        print("   ", e)
    print(f"宿主页面报错（BOSS 自身，供参考）: {len(errors) - len(ours)}")


async def snap(page, name, sel=None):
    await page.wait_for_timeout(300)
    t = page.locator(sel) if sel else page
    await t.screenshot(path=str(OUT / f"{name}.png"))
    print(f"  已保存 real/{name}.png")


async def shots(page, errors) -> None:
    # --- 1. Tab 切换（整页，能看到面板叠在真实 BOSS 内容上）---
    await page.click(".aah-ball")
    await page.wait_for_selector(".aah-drawer", timeout=8000)
    await snap(page, "r1-tab-apply")
    await page.click(".aah-tab:has-text('会话')")
    await snap(page, "r2-tab-chat")

    # --- 2. ⚙ 跳设置并高亮 ---
    await page.click(".aah-icon-btn[title='设置']")
    active = await page.locator(".aah-tab.active").inner_text()
    # 不把 ⚙ 打到 stdout：Windows 控制台是 GBK，U+2699 编不出来会抛 UnicodeEncodeError
    print(f"  点齿轮后激活的 Tab = {active.strip()!r}")
    if "设置" not in active:
        errors.append(f"aah: 点齿轮后未跳到设置 Tab（当前 {active!r}）")
    await snap(page, "r3-gear-to-settings")

    # --- 3. 拖拽悬浮球（先收起面板回到球态）---
    await page.click(".aah-icon-btn[title='收起']")
    await page.wait_for_selector(".aah-ball", timeout=8000)
    ball = page.locator(".aah-ball")
    b0 = await ball.bounding_box()
    await snap(page, "r4-ball-before-drag")
    await page.mouse.move(b0["x"] + 24, b0["y"] + 24)
    await page.mouse.down()
    await page.mouse.move(b0["x"] + 24 - 260, b0["y"] + 24 + 300, steps=15)
    await page.mouse.up()
    await page.wait_for_timeout(300)
    b1 = await ball.bounding_box()
    print(f"  拖拽 ({b0['x']:.0f},{b0['y']:.0f}) → ({b1['x']:.0f},{b1['y']:.0f})")
    moved = abs(b1["x"] - b0["x"]) > 50 and abs(b1["y"] - b0["y"]) > 50
    print(f"  拖拽是否生效: {moved}")
    if not moved:
        errors.append("aah: 悬浮球拖拽未生效")
    await snap(page, "r5-ball-after-drag")

    # --- 4. 缩窗夹紧 ---
    await page.set_viewport_size({"width": 900, "height": 500})
    await page.wait_for_timeout(800)  # 200ms 防抖 + 余量
    b2 = await ball.bounding_box()
    inside = b2["y"] + b2["height"] <= 500
    print(f"  缩窗 768→500 后 球 y={b2['y']:.0f}，底边={b2['y'] + b2['height']:.0f}，在视口内={inside}")
    if not inside:
        errors.append(f"aah: 缩窗后悬浮球仍在视口外 y={b2['y']}")
    await snap(page, "r6-ball-after-resize")


if __name__ == "__main__":
    asyncio.run(main())

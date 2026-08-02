#!/usr/bin/env python3
"""油猴插件选择器自动化验证工具。

用 Playwright 打开四平台搜索页，验证油猴插件中的 DOM 选择器是否能找到目标元素。
（原为主项目 tools/verify_tampermonkey_selectors.py，随插件拆分为独立仓库迁移至此）

使用方法：
    python tools/verify-selectors.py --platforms zhaopin qiancheng
    python tools/verify-selectors.py --all  # 验证所有平台

输出：
    - 截图：docs/screenshots/tampermonkey_<platform>.png
    - 验证报告：控制台输出各选择器是否找到元素
    - 提取的实际 class 名（供修复选择器参考）

注意：
    - 智联/51 搜索页游客可见，无需 Cookie
    - BOSS/猎聘 可能需登录态才能看完整列表，可传 --cookie-file
"""
import asyncio
import argparse
import json
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass

try:
    from playwright.async_api import async_playwright, Page
except ImportError:
    print("❌ 需要安装 playwright: pip install playwright && playwright install chromium")
    exit(1)


@dataclass
class SelectorTest:
    """单个选择器测试用例"""
    name: str  # 描述（如 "职位卡片容器"）
    selector: str  # CSS 选择器
    should_find_multiple: bool = False  # 是否期望找到多个元素


# ---------- 各平台选择器定义（与 src/platforms/ 代码对齐） ----------

PLATFORM_TESTS = {
    "zhaopin": {
        "url": "https://sou.zhaopin.com/?jl=763&kw=Python&kt=3",
        "tests": [
            SelectorTest("职位卡片容器", ".joblist-box__item", True),
            SelectorTest("职位详情链接", "a.jobinfo__name, a[href*='/jobdetail/']", False),
            SelectorTest("职位标题（链接文本）", "a.jobinfo__name", False),
            SelectorTest("公司名", ".companyinfo__name", False),
            SelectorTest("薪资", ".jobinfo__salary", False),
            SelectorTest("城市", ".jobinfo__other-info-item span", False),
            SelectorTest("投递按钮（列表）", "button, a", False),
        ],
    },
    "qiancheng": {
        "url": "https://we.51job.com/pc/search?keyword=Python&searchType=2&sortType=0&metro=",
        "tests": [
            SelectorTest("职位卡片容器", ".joblist-item, .j_joblist .e, div[class*='joblist'] div[class*='item']", True),
            SelectorTest("职位详情链接", "a[href*='jobs.51job.com'], a.el, a[href*='/job/']", False),
            SelectorTest("职位标题", ".jname, .job-title, [class*='jobname']", False),
            SelectorTest("公司名", ".cname, .company-name, [class*='company']", False),
            SelectorTest("薪资", ".sal, .job-salary, [class*='salary']", False),
            SelectorTest("城市", ".d.at, [class*='area']", False),
            SelectorTest("投递按钮", "button, a, .el-button", False),
        ],
    },
    "zhipin": {
        "url": "https://www.zhipin.com/web/geek/job?query=Python&city=101010100",
        "tests": [
            SelectorTest("职位卡片容器", "li.job-card-wrapper, .job-list-box > li", True),
            SelectorTest("职位详情链接", "a.job-card-left, a[href*='job_detail']", False),
            SelectorTest("职位标题", ".job-name, .job-title", False),
            SelectorTest("公司名", ".company-name, .boss-name", False),
            SelectorTest("薪资", ".salary, .job-salary", False),
            SelectorTest("城市", ".job-area, .city", False),
            SelectorTest("标签列表", ".tag-list li, .job-card-footer .tag", False),
            SelectorTest("立即沟通按钮（详情页）", ".btn-startchat, .start-chat-btn, a.op-btn-chat", False),
        ],
    },
    "liepin": {
        "url": "https://www.liepin.com/zhaopin/?key=Python&dqs=010",
        "tests": [
            SelectorTest("职位卡片容器", ".job-card-box, .job-list-item, div[class*='job-card']", True),
            SelectorTest("职位详情链接", "a[href*='/job/'], a.job-card-job-info", False),
            SelectorTest("职位标题", ".job-title-box, .ellipsis-1, [class*='job-title']", False),
            SelectorTest("公司名", ".company-name, [class*='company']", False),
            SelectorTest("薪资", ".job-salary, [class*='salary']", False),
            SelectorTest("城市", ".job-dq-box, [class*='area']", False),
            SelectorTest("投递按钮", "button, a", False),
        ],
    },
}


class SelectorValidator:
    """选择器验证器"""

    def __init__(self, headless: bool = False, cookie_file: Optional[str] = None):
        self.headless = headless
        self.cookie_file = cookie_file
        self.screenshot_dir = Path("docs/screenshots")
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)

    async def validate_platform(self, platform: str) -> Dict:
        """验证单个平台的所有选择器"""
        config = PLATFORM_TESTS.get(platform)
        if not config:
            return {"error": f"未配置平台: {platform}"}

        print(f"\n{'='*60}")
        print(f"验证平台: {platform.upper()}")
        print(f"URL: {config['url']}")
        print(f"{'='*60}\n")

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=self.headless,
                args=["--disable-blink-features=AutomationControlled"],
            )
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )

            # 加载 Cookie（如果提供）
            if self.cookie_file and Path(self.cookie_file).exists():
                with open(self.cookie_file) as f:
                    cookies = json.load(f)
                    # 只加载当前平台相关的 Cookie
                    platform_cookies = [
                        c for c in cookies
                        if platform in c.get("domain", "")
                    ]
                    if platform_cookies:
                        await context.add_cookies(platform_cookies)
                        print(f"[OK] 已加载 {len(platform_cookies)} 个 Cookie")

            page = await context.new_page()

            try:
                # 访问搜索页
                print(f"[访问] 正在访问 {config['url']} ...")
                await page.goto(config['url'], wait_until="networkidle", timeout=30000)
                await asyncio.sleep(3)  # 等待 JS 渲染

                # 截图
                screenshot_path = self.screenshot_dir / f"tampermonkey_{platform}.png"
                await page.screenshot(path=str(screenshot_path), full_page=True)
                print(f"[截图] 已保存: {screenshot_path}\n")

                # 测试各选择器
                results = []
                for test in config["tests"]:
                    result = await self._test_selector(page, test)
                    results.append(result)
                    self._print_result(result)

                # 额外：提取第一个卡片的实际结构（供参考）
                await self._extract_card_structure(page, platform)

                return {
                    "platform": platform,
                    "url": config["url"],
                    "screenshot": str(screenshot_path),
                    "results": results,
                }

            except Exception as e:
                print(f"[X] 验证失败: {e}")
                return {"platform": platform, "error": str(e)}
            finally:
                await browser.close()

    async def _test_selector(self, page: Page, test: SelectorTest) -> Dict:
        """测试单个选择器"""
        try:
            elements = await page.query_selector_all(test.selector)
            count = len(elements)

            # 提取找到的元素的实际 class 名（前 3 个）
            actual_classes = []
            for el in elements[:3]:
                class_attr = await el.get_attribute("class")
                if class_attr:
                    actual_classes.append(class_attr)

            return {
                "name": test.name,
                "selector": test.selector,
                "found": count > 0,
                "count": count,
                "expected_multiple": test.should_find_multiple,
                "actual_classes": actual_classes,
            }
        except Exception as e:
            return {
                "name": test.name,
                "selector": test.selector,
                "found": False,
                "error": str(e),
            }

    def _print_result(self, result: Dict):
        """打印单个测试结果"""
        status = "[OK]" if result["found"] else "[FAIL]"
        name = result["name"]
        count = result.get("count", 0)

        print(f"{status} {name}: ", end="")

        if result["found"]:
            print(f"找到 {count} 个元素")
            if result.get("actual_classes"):
                print(f"   实际 class: {result['actual_classes'][0]}")
        else:
            error = result.get("error", "未找到元素")
            print(f"[X] {error}")
            print(f"   选择器: {result['selector']}")
        print()

    async def _extract_card_structure(self, page: Page, platform: str):
        """提取第一个职位卡片的详细结构（调试用）"""
        print(f"\n{'-'*60}")
        print("[结构] 第一个职位卡片的结构分析：")
        print(f"{'-'*60}\n")

        # 根据平台选择卡片容器选择器
        card_selector = {
            "zhaopin": ".joblist-box__item, .job-card",
            "qiancheng": ".joblist-item, .j_joblist .e",
            "zhipin": "li.job-card-wrapper, .job-list-box > li",
            "liepin": ".job-card-box, .job-list-item",
        }.get(platform, "div")

        try:
            first_card = await page.query_selector(card_selector)
            if not first_card:
                print("[X] 未找到职位卡片")
                return

            # 提取卡片的 outerHTML（限制长度）
            html = await first_card.evaluate("el => el.outerHTML")
            lines = html.split("\n")[:20]  # 只看前 20 行
            print("\n".join(lines))
            print(f"\n... (共 {len(html)} 字符)")

        except Exception as e:
            print(f"[X] 提取失败: {e}")


async def main():
    parser = argparse.ArgumentParser(description="验证油猴插件的 DOM 选择器")
    parser.add_argument(
        "--platforms",
        nargs="+",
        choices=["zhaopin", "qiancheng", "zhipin", "liepin"],
        help="要验证的平台（多个用空格分隔）",
    )
    parser.add_argument("--all", action="store_true", help="验证所有平台")
    parser.add_argument("--headless", action="store_true", help="无头模式（不显示浏览器窗口）")
    parser.add_argument("--cookie-file", help="Cookie JSON 文件路径（可选）")
    args = parser.parse_args()

    if args.all:
        platforms = list(PLATFORM_TESTS.keys())
    elif args.platforms:
        platforms = args.platforms
    else:
        # 默认验证智联和51（游客可访问，最容易验证）
        platforms = ["zhaopin", "qiancheng"]

    validator = SelectorValidator(headless=args.headless, cookie_file=args.cookie_file)

    print("\n" + "="*60)
    print("[验证] 油猴插件选择器验证工具")
    print("="*60)
    print(f"验证平台: {', '.join(platforms)}")
    print(f"无头模式: {'是' if args.headless else '否'}")
    print(f"Cookie 文件: {args.cookie_file or '未提供（游客访问）'}")

    all_results = []
    for platform in platforms:
        result = await validator.validate_platform(platform)
        all_results.append(result)

    # 汇总报告
    print("\n" + "="*60)
    print("[汇总] 验证报告")
    print("="*60 + "\n")

    for result in all_results:
        platform = result.get("platform", "未知")
        if "error" in result:
            print(f"[X] {platform.upper()}: {result['error']}")
        else:
            results = result.get("results", [])
            passed = sum(1 for r in results if r.get("found"))
            total = len(results)
            status = "[OK]" if passed == total else "[WARN]"
            print(f"{status} {platform.upper()}: {passed}/{total} 选择器通过")

    print("\n[完成] 验证完成！请查看截图和上述报告。")


if __name__ == "__main__":
    asyncio.run(main())

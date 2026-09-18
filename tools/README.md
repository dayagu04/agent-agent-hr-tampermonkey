# 插件界面与选择器检查

从插件仓库根目录构建脚本并安装截图依赖：

```bash
npm ci
npm run build
python -m pip install playwright
python -m playwright install chromium
```

| 工具 | 用途 | 命令 |
|---|---|---|
| `shoot.py` | 将构建后的用户脚本注入本地替身页，检查面板布局与交互 | `python tools/shoot.py` |
| `real_shoot.py` | 在未登录的 BOSS 页面检查面板注入和自身交互 | `python tools/real_shoot.py` |
| `verify-selectors.py` | 在实际招聘页面探查选择器命中情况；可能受页面登录或验证要求影响 | `python tools/verify-selectors.py --platforms zhaopin qiancheng` |

截图输出到被忽略的 `docs/screenshots/`；`shoot.py` 的临时文件放在被忽略的 `tools/.shot-stage/`。本地替身页不验证真实平台 DOM；`real_shoot.py` 只操作插件面板，不执行投递，也不能证明真实职位或聊天页的选择器正确。平台适配仍需在目标页面单独验证。

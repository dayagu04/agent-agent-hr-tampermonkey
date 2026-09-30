import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 在 Windows 下直接 spawnSync npm.cmd 可能返回 EINVAL（尤其是通过
// PowerShell/Codex 启动时）。直接调用当前 Node 执行 Vite，避免依赖 shell。
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const env = {
  ...process.env,
  VITE_API_BASE: process.env.VITE_API_BASE || 'http://127.0.0.1:8010',
}

// 不使用 --mode local：Vite 保留 `.local` 作为 env 文件后缀，mode 名称会冲突。
const result = spawnSync(process.execPath, [viteCli, 'build'], {
  env,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)

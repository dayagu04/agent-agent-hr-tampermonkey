# 插件后端 API 契约（/api/plugin/*）

插件与主项目解耦的唯一运行时依赖：所有后端能力都通过 `GM_xmlhttpRequest` 调用
本契约定义的接口完成。接口由主项目 `server/routers/plugin.py` 实现。

## 通用约定

- Base URL：插件配置里的 `apiBase`（生产默认 `https://gudaya.chat`，本地开发 `http://localhost:8010`）
- 鉴权：`Authorization: Bearer <JWT>`（用户在网页登录后复制 token 到插件配置）
- 内容类型：`application/json`
- 本契约变更时同步 bump 契约版本（建议服务端用 `/api/plugin/v1/*` 演进，保证新旧插件共存）

## 端点清单

| 方法 | 路径 | 用途 |
|------|------|------|
| GET  | /api/plugin/config | 拉取简历列表 + 默认阈值 |
| POST | /api/plugin/match | 批量计算岗位匹配度（复用 MatchAgent） |
| GET  | /api/plugin/rules | 拉取投递过滤规则（黑白名单 / 最低薪资） |
| GET  | /api/plugin/quota/{platform} | 平台配额与封禁状态 |
| POST | /api/plugin/greeting | 取打招呼语（BOSS 首条消息） |
| POST | /api/plugin/decision | 上报跳过 / 失败原因 |
| POST | /api/plugin/chat/sync | 上报会话消息，取回后端回复 |
| POST | /api/plugin/chat/sync-batch | 批量会话处理（性能优化） |
| GET  | /api/plugin/chat/manifest | 后端已知会话的轻量清单 |
| POST | /api/plugin/chat/deleted | 批量写入已删除会话台账（幂等） |
| POST | /api/plugin/chat/restore | 撤销已删除台账（误报恢复） |
| POST | /api/plugin/chat/sent | 回报回复真实发送结果 |
| POST | /api/plugin/record | 记录一次投递（source=tampermonkey） |
| POST | /api/plugin/orchestrator/event | 上报编排器事件（阶段切换 / 批次完成 / 停止） |

## 演进规则

1. 插件新增端点前，先在 `src/api.ts` 定义类型，再同步本契约。
2. 服务端实现必须与本文档一致；字段只能增量，不能删改（旧版插件兼容）。
3. 破坏性变更（改字段 / 删端点）必须 bump 契约版本。

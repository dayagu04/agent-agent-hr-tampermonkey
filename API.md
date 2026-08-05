# 插件后端 API 契约

插件与主项目解耦的唯一运行时依赖：所有后端能力都通过跨域 HTTP 调用本契约
定义的接口完成，由主项目 `server/routers/plugin.py` 等实现。

## 通用约定

- Base URL：插件配置里的 `apiBase`（生产默认 `https://gudaya.chat`，本地开发 `http://localhost:8010`）
- 鉴权：`Authorization: Bearer <JWT>`（插件内邮箱密码登录获取，或粘贴网页端 Token）
- 内容类型：`application/json`

## 端点清单

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | /api/auth/login | 邮箱密码登录，换取 JWT |
| GET  | /api/plugin/config | 拉取简历列表 + 默认阈值 + 求职偏好 + 建议关键词 |
| POST | /api/plugin/match | 批量计算岗位匹配度 |
| GET  | /api/plugin/rules | 拉取投递过滤规则（黑白名单 / 最低薪资） |
| POST | /api/plugin/greeting | 取打招呼语（BOSS 首条消息） |
| POST | /api/plugin/decision | 上报跳过 / 失败原因 |
| POST | /api/plugin/chat/sent | 回报回复真实发送结果 |
| POST | /api/plugin/chat/snapshot | 上报会话行全量快照（DOM 结构 / 状态标签，评估用） |
| POST | /api/plugin/record | 记录一次投递 |
| POST | /api/plugin/orchestrator/event | 上报编排器事件（阶段切换 / 批次完成 / 停止） |
| POST | /api/plugin/heartbeat | 心跳 + 命令轮询（返回待执行远程命令 / 后端编排指令） |
| GET  | /api/plugin/status | 网页端查询插件连接状态（90s 内有心跳视为在线） |
| POST | /api/plugin/commands | 网页端入队远程命令（orchestrator.start / pause / resume / stop / action） |
| PUT  | /api/plugin/preferences | 网页端写入插件偏好（回复模式 / 回复条数 / 已读清理） |
| POST | /api/plugin/logs | 插件批量上报诊断日志（按 JWT 用户落库） |
| GET  | /api/conversations/list | 拉取最近会话摘要（HR 消息正文/时间/匹配分） |

## 演进规则

1. 插件新增端点前，先在 `src/api.ts` 定义类型，再同步本契约。
2. 服务端实现必须与本文档一致；字段只能增量，不能删改（兼容旧版插件）。
3. 破坏性变更（改字段 / 删端点）必须同步更新插件代码与本契约。

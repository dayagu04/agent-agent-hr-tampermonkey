# 谷谷浏览器扩展

`agent-agent-hr-extension` 是独立 Git 仓库，主项目以子模块引用。这里管理两个独立安装、独立运行和独立发布的 Chrome/Edge Manifest V3 扩展。

| 产品 | 源码 | 安装目录 | 责任 |
|---|---|---|---|
| 谷谷求职 Agent | `apps/boss-agent/` | `dist/boss-agent/` | 保留原悬浮窗、投递控制、进度、会话和设置，同时向 Agent 提供页面工具 |
| 谷谷网申助手 | `apps/application-autofill/` | `dist/application-autofill/` | 用户主动扫描、填写和核对网申资料；最终提交由用户完成 |

两个扩展各自拥有 manifest、后台、UI、权限、登录、存储、版本号和 ZIP，不要求同时安装，不同步 token 或运行状态。共享的是源码仓库。网申代码来源为原独立仓 main `1de4f48`，以 subtree 保留来源历史，没有导入旧功能分支或被放弃的未提交内容。

## 迁移范围与当前阶段

本次迁移只更换实现方式：由油猴宿主改为 Chrome/Edge Manifest V3，原功能和使用方式保留，CLI 是辅助验证入口。悬浮窗、拖拽与收起、登录与简历同步、投递开始/停止、进度、会话列表及设置都是迁移目标，不以 popup 替代。

原 Vue 悬浮窗及投递、进度、会话、设置已接入 MV3：`panel.html` 在扩展自己的 iframe 中运行 `packages/boss-core/src/` 的原界面和控制器，页面内收起、展开、拖动和操作入口保持原样。`apps/boss-agent/` 后台统一负责原生登录、存储、网络、心跳和页面执行权；`legacy/userscript/` 仅承载旧宿主适配和开发加载器。代码与构建验证不代替 Chrome/Edge 真实页面验收。

BOSS 0.7.1 修复扩展面板启动被拒绝及错误提示裁切的问题，需要 Chromium 116 或以上。后台通过 Chrome 的活动扩展上下文验证面板，通过导航接口验证顶层 BOSS 文档；iframe 挂在封闭 shadow root 内隔离页面样式和通用 iframe 扫描。shadow root 只隔离界面，不承担认证。扩展重载后会重新挂载已打开、可用的 BOSS 页，保留登录和配置；冻结页等待恢复，未确认动作仍先核查。

BOSS 0.7.2 继续迁移原子工具：原生 `apply_job` 直接接收上层给定的招呼语与本次记账简历，不再强制请求话术生成。原悬浮窗和批量控制的既有流程保留；原子工具的可用性不依赖面板是否展开。

BOSS 0.8.0 增加只读附件状态，补齐卡片唯一定位、处理结果确认和原界面删除记账的实际会话身份。附件与卡片工具保留原操作入口，由 Agent 明确指定材料和同意/拒绝；工具只报告页面事实。

## 构建与安装

Node.js 22.15 或以上：

```bash
npm ci
npm --prefix apps/application-autofill ci
npm run build
npm run package
```

分别在 Chrome/Edge 扩展管理页开启开发者模式，加载对应 `dist/<产品>/` 目录。构建各自只清理本产品目录，不删除旧的根目录 userscript 或另一扩展产物。ZIP 位于 `dist/packages/`；下载后分别解压到各产品固定的安装目录，再加载其中直接包含 `manifest.json` 的目录。不能加载公共 `dist/` 或 `dist/packages/`，也不能把 ZIP 当作油猴更新脚本直接安装。后续升级覆盖同一目录，重新加载该扩展并刷新对应招聘页；不要每个版本更换安装路径。

BOSS 扩展首次使用：先暂停上游 Agent，等待已领取的投递/发送等动作完成；结果不确定时先只读核查。停用同一账号旧油猴脚本并刷新所有 BOSS 页面；在 BOSS 页的原悬浮窗中设置 API、登录或粘贴网站 Token、同步并选择简历，继续使用原来的投递、会话和设置入口；首次登录可自动绑定当前 BOSS 页。popup 保留手动选择执行页、启用/停用连接的辅助入口；主动停用后需在 popup 重新启用。页面使用 BOSS 原有登录态，插件的 API 登录与 BOSS 登录分别处理。未连接/冻结的执行页不应被当成已完成动作。

切换前还需用旧客户端停止仍在运行的批量/会话任务，确认停止命令已 ACK。新客户端不接管旧编排；若出现 `unsupported_command`，应停用新连接，回到旧客户端完成停止及命令交接。不要手工删除待确认命令，也不要让新客户端跳过未知命令的 ACK。

从原 `browser-extension/dist/` 迁移网申扩展时，先停用原“谷谷网申助手”并刷新已打开的 ATS 页面，再加载新的 `dist/application-autofill/`，按新安装重新登录。换目录加载会产生新的扩展 ID，旧扩展的登录、缓存和本页临时修改不会自动迁移；不要同时启用新旧两个网申扩展。保留原安装目录便于回滚。网申保持独立登录、主动填写及不自动提交规则，见 [网申说明](apps/application-autofill/README.md)。

回滚 BOSS 时先暂停 Agent、停用新扩展，核查未确认动作和待回报队列，刷新所有 BOSS 页面终止新实例，再启用旧油猴。回滚网申时先停用新网申扩展、刷新 ATS 页面，再启用原目录的旧扩展并检查登录与资料；已填写的网页内容需要用户核对，不自动撤销。两个产品各自回滚，互不切换执行端。

## Agent 调用原子工具

服务端负责决策，扩展负责在真实页面执行并返回事实。工具规范与平台回执见 [AGENTS.md](AGENTS.md)，运行边界见 [扩展架构](docs/extension-architecture.md)。

```text
Agent function call {name, arguments, id}
  -> POST /api/plugin/tools/call {name, args, request_id: id}
  -> 持久命令队列 -> BOSS 扩展 -> 页面原子操作
  -> POST /api/plugin/tools/result
  -> GET /api/plugin/tools/result/{command_id}
```

配套服务端 `GET /api/plugin/tools` 提供当前在线客户端声明的 function-call JSON Schema；旧客户端未声明参数时不伪造 schema。原有 `list_tools` 也返回扩展自己的参数目录。

```bash
npm run tool -- status
npm run tool -- functions
npm run tool -- list
npm run tool -- open_search '{"keyword":"客服","cityCode":"101010100"}'
npm run tool -- scan_jobs '{"withDetail":true,"offset":0,"limit":10}'
npm run tool -- read_job_detail '{"jobId":"<实际扫描得到的岗位ID>"}'
# 查询已有调用，command_id 使用入队时输出的实际值：
npm run tool -- result <command_id>
npm run tool -- wait <command_id>
# 投递、发消息、发简历、删会话均有真实副作用；按上游授权调用。
```

CLI 默认连接本地 `127.0.0.1:8010`；用 `AAH_API`、`AAH_TOKEN` 或测试账号环境变量指定连接。远端必须使用 HTTPS 并显式提供凭据，不会发送本地默认账号。CLI 自动为新调用生成 `request_id`，入队前输出该 ID，入队后立即输出 `command_id`；上游可用 `AAH_REQUEST_ID` 传入同一次 function call 的稳定 ID。POST 响应丢失时复用原 ID 和原参数，结果等待超时则用 `result` / `wait` 查询原 command_id，不创建新调用。`AAH_HTTP_TIMEOUT` 控制单次 HTTP 超时（默认15秒），`AAH_WAIT` 控制结果等待（默认90秒）。查询尚未完成的结果退出码为2，失败/超时为1，成功为0。

`status` 和 `functions` 都只读后端状态，不入队；`connected=false` 或目录为空表示没有已确认的执行端，后端登录成功不等于扩展已登录/连接。旧后端没有发现接口时 `functions` 明确返回 HTTP 404。首次安装通过扩展管理页完成，扩展登录可在原悬浮窗或 popup 完成，之后用 CLI 调用工具，不需要操作 BOSS 页面。

`scan_jobs` 返回 `count/total/offset/limit/hasMore/nextOffset`；`withDetail=true` 默认且最多每批10个岗位，继续使用返回的 `nextOffset`。不带明细且未指定 limit 时保留整页列表。offset 基于本次页面列表顺序，翻页、筛选或列表变化后应重新扫描，不能将它当作稳定快照游标。

`open_thread` 指定岗位未匹配时返回 `not-found`，同公司多条匹配返回 `ambiguous`，不会退回首条；只有页面头部的公司、HR和岗位与目标一致才返回 `ok`。跨页调用首先回报 `navigating`，扩展最多尝试5次定位；完成后在同一个 command_id 上回报实际结果。CLI 的 `wait` 会等待过渡结束，`result` 对过渡状态返回 pending/退出码2。歧义立即终止。定位失败后仍可读状态/会话，发送等动作返回 `navigation_recovery_required`；用明确目标再次 `open_thread` 成功后恢复。旧油猴没有最终定位回报时，等待会超时，需通过 `read_thread_header` 另行确认。

原生 `open_thread`、`read_thread_header`、`delete_thread` 可附带 `list_threads` 返回的 `jobId`。ID 未命中不会退回公司首条；即使列表岗位名称与聊天头部不同，也须固定唯一 ID、核对公司与 HR，并确认真实头部符合请求岗位。头部没有稳定 ID 时，同公司同 HR 的多候选会保守拒绝。跨页恢复保留此 ID；旧无 ID 调用保持原语义，当前保留的旧油猴入口对新 ID 明确拒绝，避免静默丢失目标。

搜索/岗位工具返回岗位 ID、公司、名称、地点、薪资、JD 和来源 URL；详情和会话工具使用页面实际值。`send_message` 保留 `delivered/read/sending/failed/none` 回执；`sending` 已上屏，不能因尚无送达回执而重发。

原生 `apply_job` 参数为 `{jobId, greeting?, resumeId?}`。`greeting` 缺省为空，由 Agent 决定内容；平台自动发送默认招呼时不会追加第二条，查看 `greetingSource` / `customGreetingSent` 区分事实。`resumeId` 只用于后端记账，必须属于当前账号；缺省使用面板已选简历，不会发送附件或改变默认配置。后端记账仍沿用简历关联 Agent 的现有约束。校验或页面准备阶段失败返回 `mayHaveExecuted=false`；执行开始后的不确定结果仍需核查。旧油猴缺省话术与原界面编排保持原行为。

`read_resume_state` 只读当前会话的附件入口、已打开选择框和候选附件，不打开弹窗或发送。`send_resume` 使用显式 `resumeName` 或 `resumeIndex`（二者不可同时指定）；未指定时沿用用户配置，不能猜多份材料中哪份要发。发送成功须观察本次新增的附件消息标记，弹窗消失不等于成功。

`list_pending_cards` 返回问题、可选动作与 `cardKey`。`click_card` 的 `kind` 和布尔 `accept` 必填；多张同类卡片须传 `cardKey`，缺省仅在目标唯一时执行。卡片不会按本地偏好自行同意；非附件卡需确认平台已处理，索要附件卡需确认新附件消息。结果不明保留处理标记并回报 `mayHaveExecuted` / `retrySafe`，不要再点击或用新命令重复发送。会话切换会中止后续点击和回执判断。

结果查询 `200 done` 表示结果已回传；`202 queued/delivered/acked` 表示队列阶段。不可撤回动作在 delivered/acked 或客户端返回 `reconciliation_required` 时，先只读核查，不自动重新入队。扩展重启后对执行中断的动作保留核查状态，页面动作和数据库上报分别处理，不以接口成功伪造平台成功。

## 开发与发布

```bash
npm run typecheck
npm run test:core             # 共享业务与页面契约
npm run test:legacy           # 仅旧宿主兼容契约
npm run test:autofill         # 网申自己的既有契约
npm run build:boss
npm run build:autofill
npm run check:artifacts
```

现有 CI 入口 `typecheck:userscript` / `test:userscript` 继续验证共享 core 与旧适配器；无需改 GitHub 工作流即可覆盖新目录。BOSS MV3 的运行时测试由其专用配置执行，CI 与共享页面契约分开选择；不要为小改动反复跑全部矩阵。页面真实回归不由 mock/jsdom 或构建检查代替。

- BOSS：`apps/boss-agent/package.json` / manifest，发布标签 `boss-vX.Y.Z`。
- 网申：`apps/application-autofill/package.json` / manifest，发布标签 `autofill-vX.Y.Z`。
- 两产品各自发布，不互相 bump；CI 生成分别可安装的 ZIP。
- 新扩展 Release 不占用通用 latest；旧油猴 `v*` 通道继续保留自己的更新资产。
- 不提交 dist、凭据、简历、完整 DOM 或会话正文。

## 油猴兼容入口

`packages/boss-core/src/` 是与宿主无关的完整功能源码，不依赖 GM 全局。`legacy/userscript/src/` 保留原安装与回滚所需的入口、GM 适配器和开发加载器；只有旧构建显式安装这个适配器。MV3 不导入该目录，也不使用油猴 CDN 或动态开发加载器。

共享代码通过 `PlatformRuntime` 的存储、网络、通知与同步配置快照接口调用宿主能力；MV3 的原生后台存储与网络已复用该接口。完整面板、编排和台账复用同一认证与执行通道。后台把已知编排命令交给原控制器，只由后台维护心跳与连续 ACK；停止/暂停可及时打断长动作，未知命令仍不执行或越过 ACK。导航恢复原进度；意外刷新、后台重启或断连留下的未确认副作用进入暂停核查，不自动重做。
```bash
npm run build:userscript      # dist/agent-agent-hr-tampermonkey.user.js
npm run build:local           # 旧油猴本地联调包
npm run dev:serve             # 仅油猴开发加载器
```

油猴专用的 CDN/动态开发加载器不会进入 MV3 包；MV3 开发采用本地构建、扩展重载与页面重载。新扩展运行时不用 Tampermonkey。

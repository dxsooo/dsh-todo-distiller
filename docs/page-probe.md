# 专属页面探路记录(第 0 步)

分支 `dev`。目标:验证"侧栏入口 + 专属页面 + 每个文档一个 DSH 会话"这条路走得通。

## 结构

| 文件 | 作用 |
|---|---|
| `src/app.ts` | Host 插件(包的主入口)。注册 `/todo-distiller/*` 路由;`POST run` 为每份文档 `ctx.agents.create` 一个 Agent,在其作用域里注册系统提示词和两个工具,`followup` 文档全文,`whenIdle` 后返回结果 |
| `src/prompt.ts` | 页面模式的系统提示词(无人对话的自动流程) |
| `src/client/index.tsx` | 浏览器插件。`slots.inject('sidebar.panellist')` 加侧栏入口,`slots.inject('main')` 注册页面;页面整体是投放区 |
| `scripts/build-client.mjs` | esbuild 打包为 `window.__ModuleLoader__.load({ id: 包名, factory })` 格式,React 等平台模块走宿主的 `require` |
| `src/index.ts`、`src/reminders.ts` | 新增 `registerDistillTool`、`registerRemindersTool`,可在 Agent 作用域内注册,并回调结果 |

preset 已移除;`cordis.patch.yml` 只插入一行包本身。

## 已验证(2026-11-19,DSH 0.2.2-rc.3 源码,`--patch`)

- 启动无报错;侧栏出现"待办助理",点开是投放页。
- 未带 token 访问 `/todo-distiller/ping` 返回 401:路由默认要求登录,不用自己做鉴权。
- 页面内 `fetch('todo-distiller/ping')` 返回 200,带当前默认模型。
- `POST run`(无待办的文本):创建会话、调用模型、正确地不调用写入工具,1.7 秒;`assistant/message` 上有 provider 上报的用量(输入 2123、输出 61 tokens)。
- 模型凭证在 Host 侧,浏览器没登录也能跑。

## 发现的问题(第 1 步要处理)

1. **会话没有持久化,DSH 的界面看不到它。** `agents.create` 后 `dispose()` 会移除会话,`~/.dsh/sessions` 里没有它,DSH 自带的用量统计也看不到。DSH 实验包 `dsh-webhook` 的做法是:`workspaceRegistry.create(path)` + `workspace.attachSession(id)`,并且不立即 dispose,会话成为普通会话。要获得 DSH 原生的会话记录和 token 统计,需要照这个做,并决定这些会话放在哪个工作区、是否出现在侧栏会话列表里。
2. **Agent 能看到全局工具。** 除了我们的两个工具,还有 `working_directory`、`team_task_*`(来自 base bundle 的全局注册)。用 `ctx.tools.restrict` 只放行我们的工具。
3. **请求是同步等待的。** 一次处理可能要几十秒,HTTP 请求一直挂着;刷新页面就看不到结果。第 1 步改为:提交后立即返回运行 id,结果持久化,页面轮询或订阅。
4. **依赖的服务不在 DSH 公开文档里**:`webServer`、`agents`、`agentDefaultModel`、`systemPrompt`。已作为 peer 依赖声明并限定 `engines.dsh`。
5. **写入提醒事项尚未在页面模式下验证**:需要在你启动的 DSH 里拖入样例文件实测(授权对象是启动 DSH 的应用)。

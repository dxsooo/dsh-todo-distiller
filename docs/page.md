# 专属页面(dev 分支)

侧栏入口“待办助理”打开一个投放页。拖入文件或粘贴文字后立即排队处理,不需要发送,也不开对话框。

## 流程

```
页面 POST /todo-distiller/runs  →  记录 run(queued),立即返回 202
                                  ↓ 串行队列
今天的会话:内存中有就用;存储里有就 resume;否则在专用工作区新建
                                  ↓
followup(文件名 + 接收时间 + 全文) → 模型调用 dsh_todo_distiller → dsh_todo_distiller_to_reminders
                                  ↓ whenIdle
事项和用量写入事项库,run 标为 done / error
页面 GET /todo-distiller/runs  ←  有排队或处理中的 run 时每 1.5 秒轮询
```

## 模块

| 文件 | 作用 |
|---|---|
| `src/app.ts` | Host 插件(包主入口)。打开事项库,创建 `Runner`,注册 `/todo-distiller/*` 路由;启动时把上次未完成的 run 标为中断 |
| `src/runner.ts` | 串行队列与“每天一个会话”。会话放在专用工作区(默认 `$DSH_HOME/todo-distiller/workspace`,标题“待办助理”),会话标题“待办助理 YYYY-MM-DD” |
| `src/store.ts` | 事项库,`ctx.storageDomain` 的 `todo_distiller` 域,表 `runs`、`items`、`days`(日期 → 会话 id) |
| `src/prompt.ts` | 每日会话的系统提示词 |
| `src/client/index.tsx` | 浏览器插件:侧栏入口、投放页、结果卡片 |
| `scripts/build-client.mjs` | esbuild 打包为 DSH 客户端模块格式 |

## 每日会话的组成

- 系统提示词只用我们的(`complete: true`),并关闭运行时上下文(工作目录、沙箱策略等与任务无关的信息)。
- `tools.restrict({ allow: [] })` 隐藏所有全局工具,只剩本会话注册的两个工具。
- 上下文压缩:base bundle 全局挂载了 `compaction-basic`,对所有会话生效,不需要另外挂载。
- 模型:用户在 DSH 里选的默认模型。

## 事项库

- `items` 的 id 是提醒事项幂等标记的哈希,同一事项在不同天重复出现时 id 相同,为以后跨天关联准备。没有输出的事项(只有日期的日程)用 `<runId>:<序号>`。
- 数据在 `~/.dsh/storages/todo_distiller.json`(DSH 默认的 JSON 后端)。

## 已验证(2026-11-19,DSH 0.2.2-rc.3 源码,`--patch`)

- 侧栏入口和投放页;未登录访问返回 401。
- 连续提交两份文档:立即返回 202,按顺序处理,进入同一个会话。
- 会话持久化到 `~/.dsh/sessions/<工作区>/todo-distiller-<日期>-<后缀>`;侧栏出现“待办助理”工作区。
- 请求头里的工具只有 `dsh_todo_distiller`、`dsh_todo_distiller_to_reminders`。
- 重启 DSH 后,同一天的新文档 resume 了原会话;历史 run 仍在页面上。
- 用量来自 provider:第二份文档起大部分输入命中缓存(例:未缓存 247、缓存 2048、输出 19)。

## 未验证 / 已知限制

- 页面模式下写入提醒事项:需要在你启动的 DSH 里拖入样例实测(授权对象是启动 DSH 的应用)。
- 用户在侧栏点开今天的会话并在 DSH 重启后先于页面恢复它,那个会话没有我们的工具;此时页面会为当天新建一个会话。
- 只支持 `.md`、`.txt`。
- 依赖的 `webServer`、`agents`、`agentDefaultModel`、`systemPrompt`、`storageDomain`、`workspaceRegistry` 不在 DSH 公开文档里;已声明为 peer 依赖并限定 `engines.dsh`。

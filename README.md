# @dxsooo/dsh-todo-distiller

DeepSeek Harness 的“待办助理”。把会议记录、聊天记录里的待办和日程提炼出来,写入 macOS 提醒事项。

## 使用

要求:DeepSeek Harness `>=0.2.2-rc.5 <0.3.0`,macOS。

```sh
dsh plugin --profile web add @dxsooo/dsh-todo-distiller@next
```

1. 启动 DSH 的 Web 界面,点左侧栏的“待办助理”。
2. 把会议记录(`.md`、`.txt`,或元宝笔记等图片)拖进页面,或直接粘贴文字。不需要点发送。
3. 首次写入时 macOS 会询问是否允许控制“提醒事项”,点“好”。授权对象是启动 DSH 的应用。
4. 事项写入提醒事项里的“DSH 助理”列表,页面上列出每份文档提炼出的事项。同一份内容重复处理不会产生重复项。

每天的文档在同一个会话里处理,会话放在工作区“待办助理”下,可以在侧栏点开查看模型做了什么。之前文档里未完成的事项会提供给新文档,用来建立关联(例如“依赖”“更新”),关联显示在页面和提醒事项备注里。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `todo-distiller` 行的 `config`:

| 字段 | 默认 | 说明 |
|---|---|---|
| `list` | `DSH 助理` | 提醒事项列表名,不存在则创建 |
| `writeReminders` | `true` | `false` 时只提炼和记录,不写提醒事项 |
| `timeoutMs` | `120000` | 一次写入的超时,含首次授权等待 |
| `maxBytes` | `2097152` | 单份文本文档的最大字节数 |
| `maxImageBytes` | `10485760` | 单张图片的最大字节数 |
| `workspaceDir` | 空 | 专用工作区目录,空表示 `$DSH_HOME/todo-distiller/workspace` |
| `pageSize` | `50` | 页面列出的最近处理记录数 |
| `indexLookbackDays` | `30` | 已有事项索引只含不早于这么多天的事项 |
| `indexLimit` | `100` | 已有事项索引的最大条数 |

## 时间约定

| 表达 | 结果 |
|---|---|
| `周五前`、`6月20日前` | 当天 23:59:59(“前”包含当天) |
| `周五`、`6月30日`(待办) | 当天 23:59:59,当天 09:00 提醒 |
| `周五下午3点前` | 当天 15:00,提前 15 分钟提醒 |
| 日程只有日期 | 不写入,页面标为未确定 |
| `尽快` | 不设截止时间 |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test          # node:test
pnpm build         # tsc → dist/,esbuild → dist/client.js
pnpm dev:patch     # 生成 dev.patch.yml(源码绝对路径)
# 在 DSH 源码目录:
pnpm dsh web --patch /绝对路径/dsh-todo-distiller/dev.patch.yml
```

`@deepseek-ai/*` 和 `zod` 由宿主提供:放在 `peerDependencies`,同时在 `devDependencies` 镜像用于类型检查。设计、架构和决策见 `docs/`。

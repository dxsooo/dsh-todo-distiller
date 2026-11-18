# 架构设计

## 分工

```
原始文本(IM / 通话 / 会议 / 文档)
        │
        ▼
     模型  ── 理解文本,提取候选事项,把时间表达换算成 ISO 8601
        │  调用工具 dsh_todo_distiller
        ▼
      工具  ── 校验、回传周几、生成提醒、建立关联、归类 unresolved
        │
        ▼
  结构化结果:todos / schedules / suggestedReminders / unresolved / meta
```

工具内部不调用模型,也不读取系统时钟以外的外部状态。给定同样的输入和捕获时间,输出完全一致。

## 交付形态

用户安装一个 npm 包 `@dxsooo/dsh-todo-distiller`(一个 bundle),包内有两个 DSH 插件和一个 preset 声明:

```
bundle @dxsooo/dsh-todo-distiller
  └─ preset todo-distiller(显示名"待办助理")      cordis.patch.yml
       ├─ persona                    系统提示词:拖入文件后自动 读取 → 提炼 → 写入 → 汇报
       ├─ time-context、tool-fs、tool-ask-user    DSH 自带
       ├─ 插件 distiller      src/index.ts       工具 dsh_todo_distiller
       └─ 插件 reminders      src/reminders.ts   工具 dsh_todo_distiller_to_reminders(仅 macOS)
```

用户在界面里选择"待办助理"preset 后,把文件拖进对话框即可,不需要说明用哪个工具。流程写在 persona 里,不是代码。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件 distiller。定义 `dsh_todo_distiller` 的参数和输出 schema;`execute` 校验、归一化并保存批次 |
| `src/distill.ts` | 纯函数。`validate` 检查输入,`distill` 生成输出和提醒建议 |
| `src/time.ts` | 时区换算、ISO 8601 解析、格式化、周几。只用 `Intl` |
| `src/batches.ts` | 内存中的批次存储(最多 50 个)。两个插件共用,工具之间只传 `batchId` |
| `src/reminders.ts` | 插件 reminders。定义 `dsh_todo_distiller_to_reminders`,用 `ctx.subprocess` 调用 `osascript` |
| `src/publish.ts` | 纯函数。把批次映射成提醒事项字段,生成幂等标记 |
| `src/macos/reminders-script.ts` | JXA 脚本、`osascript` 参数构造、输出和错误解析 |
| `cordis.patch.yml` | bundle 层:声明 `todo-distiller` preset |
| `scripts/make-dev-patch.mjs` | 生成 `dev.patch.yml`(把包名换成源码绝对路径,供 `--patch` 调试) |
| `test/` | `node:test` 单元测试 |

## 工具输入

顶层参数:

| 参数 | 必填 | 说明 |
|---|---|---|
| `items` | 是 | 候选事项数组 |
| `sourceType` | 是 | `im` / `phone` / `meeting` / `document` |
| `sourceName` | 否 | 群名、会议名、文档名 |
| `sourceRef` | 否 | 消息 id、页码、链接等来源定位 |
| `capturedAt` | 否 | 文本产生时间(ISO 8601),缺省为当前时间。早于它的提醒不生成 |
| `timeZone` | 否 | IANA 时区,缺省 `Asia/Shanghai` |
| `reminderLeadMinutes` | 否 | 提前提醒分钟数,缺省 15 |

`items[]` 的字段:

| 字段 | 说明 |
|---|---|
| `kind` | 必填。`todo` 或 `schedule` |
| `title` | 必填。非空 |
| `description`、`assignee`、`location`、`priority`、`status` | 可选。`priority`: high/normal/low。`status`: open/done,缺省 open |
| `timeText` | 原文里的时间表达,原样保留 |
| `timeAssumption` | 模型做了假设时,写明如何理解 |
| `dueAt` | 待办截止时间,ISO 8601 |
| `startAt` / `endAt` | 日程开始/结束,ISO 8601。`endAt` 必须晚于 `startAt` |
| `durationMinutes` | 日程时长。给了 `endAt` 时忽略 |
| `key` | 本次调用内的标识,供 `related` 引用,必须唯一 |
| `related` | `[{ key, relation }]`,关联到其他事项 |
| `sourceQuote` | 来源原句 |
| `notes` | 纪要/备注,抽取时通常为空,事项完成后补充 |

时间字符串必须是完整的日期时间。没有时区偏移的按 `timeZone` 解释;只有日期的会被拒绝(`INVALID_ARGS`),模型可据错误信息重试。

## 工具输出

| 字段 | 说明 |
|---|---|
| `todos` | 待办。含 `id`(t1、t2…)、`dueAt`、`dueWeekday`、`dueText`、`timeAssumption`、`source`、`sourceQuote`、`related`、`notes` 等 |
| `schedules` | 日程。含 `id`(s1…)、`startAt`、`startWeekday`、`endAt`、`startText`、`location` 等 |
| `suggestedReminders` | 提醒建议:`targetId`、`remindAt`、`reason`(`before-start` / `due`) |
| `unresolved` | 没有确定时间的事项及原因 |
| `meta` | `batchId`、`capturedAt`、`timeZone`、`warnings` |

所有可空字段输出 `null`,不省略。

`dueWeekday` / `startWeekday` 由工具根据时间计算,用来核对模型的日期推算。

## 工具 dsh_todo_distiller_to_reminders

仅在 macOS 上注册。

| 参数 | 说明 |
|---|---|
| `batchId` | 必填。`dsh_todo_distiller` 返回的 `meta.batchId` |
| `ids` | 可选。只写入这些事项(如 `["t1","s1"]`),缺省全部 |

输出:`list`(列表名)、`created`、`existing`、`items[]`(`id`、`title`、`status`:`created` 或 `exists`)。

写入规则:

- 写入专用列表,默认"DSH 助理",不存在则创建。列表名和超时(含首次授权等待)是插件配置 `list`、`timeoutMs`。
- 待办的 `dueAt` 写入截止时间;日程的 `startAt` 写入截止时间,`endAt`、地点写在备注里。
- 提醒建议里对应的 `remindAt` 写入"提醒时间"(闹钟)。
- 优先级:high→高,normal→中,low→低。`status` 为 `done` 的事项以已完成状态写入。
- 备注包含描述、负责人、原文时间、时间说明、来源、原文和纪要,末尾是幂等标记 `dsh-todo-distiller:<12位哈希>`。
- **幂等**:标记由类型、标题、时间、来源名、来源引用计算。写入前读取该列表所有备注,已含标记的事项不再创建,返回 `exists`。
- 批次不存在(过期或重启后清空):返回 `BATCH_NOT_FOUND`,提示重新调用 `dsh_todo_distiller`。
- 没有自动化权限:返回 `REMINDERS_NOT_AUTHORIZED`,说明在系统设置哪里允许。

## 规则

**提醒**

- 日程:开始前 `reminderLeadMinutes` 分钟。
- 待办:截止时间的本地时分是 `23:59` 时,视为"某天之内",当天 09:00 提醒;其他时间提前 `reminderLeadMinutes` 分钟。
- `status` 为 `done` 的事项不生成提醒。
- 早于 `capturedAt` 的提醒不生成,并在 `meta.warnings` 中计数。

**unresolved**

- 待办写了 `timeText` 但没给 `dueAt`:待办保留在 `todos`,同时出现在 `unresolved`(`itemId` 指向它)。
- 日程没给 `startAt`:只出现在 `unresolved`(`itemId` 为 `null`),因为没有开始时间无法排程。

**关联**

- `related` 引用的 `key` 不存在时忽略该关联,并在 `meta.warnings` 中说明。

**警告**(`meta.warnings`):截止/开始时间早于捕获时间、关联 key 不存在、提醒被跳过。

## 扩展点

本阶段不实现,仅说明将来如何接入。

| 需求 | 接入方式 |
|---|---|
| 其他入口(Word/PDF/Excel、截图、录音、耳机、IM) | 适配器负责取得文本和 `sourceRef`,交给模型调用本工具。本工具不关心文本从哪来。较重的适配器做成可选 bundle |
| 通话、会议录音 | ASR 产出文本后走同一路径 |
| 日历事件 | 新增工具 `..._to_calendar`(日历与提醒事项是两个独立应用),消费 `schedules` |
| 其他平台的提醒 | 出现第二个实现时,把写入提醒抽成服务(定义/提供者/消费者),工具保持一个,各平台一个提供者 |

## 约束

- 模型可见的信息必须能从会话日志还原。本工具的输入输出都经过 DSH 的工具调用事件,自动满足。
- `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis` 由宿主提供,本包只声明 `peerDependencies` 并在 `devDependencies` 镜像用于类型检查。

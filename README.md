# dsh-todo-distiller

DeepSeek Harness 的“待办助理”bundle。把会议记录、聊天记录、文档里的待办和日程提炼出来,写入 macOS 提醒事项。

## 使用

要求:DeepSeek Harness `>=0.2.2-rc.3 <0.3.0`;写入提醒事项仅 macOS 可用。

```sh
dsh plugin --profile web add @dxsooo/dsh-todo-distiller@next
```

1. 启动 DSH 的 Web 界面,新建对话,选择 preset“待办助理”。也可以在设置里把它设为新任务的默认 preset。
2. 把会议记录文件拖进对话框并发送,或直接粘贴文字。不需要说明用哪个工具。
3. 首次写入时 macOS 会询问是否允许控制“提醒事项”,点“好”。授权对象是启动 DSH 的应用。
4. 事项写入提醒事项里的“DSH 助理”列表。同一份内容重复处理不会产生重复项。

每处理一个文件建议新开一个对话。

## 包含内容

| 内容 | 说明 |
|---|---|
| preset `todo-distiller` | 待办助理,流程写在提示词里 |
| 工具 `dsh_todo_distiller` | 校验模型提炼出的事项,回传周几,生成提醒建议 |
| 工具 `dsh_todo_distiller_to_reminders` | 把提炼结果写入 macOS 提醒事项(仅 macOS) |

分工:模型读文本,把“周五前”这类时间表达换算成 ISO 8601 时间,可以做合理假设并写入 `timeAssumption`。工具负责确定性部分:

- 校验 ISO 时间(缺偏移的按 `timeZone` 解释,默认 `Asia/Shanghai`)、结束晚于开始、key 唯一。
- 回传每个时间对应的周几(`dueWeekday`/`startWeekday`),用于核对模型的日期推算。
- 生成提醒建议:`23:59` 结束的截止时间在当天 09:00 提醒,其余提前 `reminderLeadMinutes`(默认 15)分钟。早于捕获时间的提醒不生成。
- 关联事项、统一来源信息。
- 模型没给出时间的日程、没给出具体时间的待办进入 `unresolved`。

提醒事项插件的配置项:`list`(列表名,默认“DSH 助理”)、`timeoutMs`(含首次授权等待的超时)。

## 时间约定

| 表达 | 模型应给出的时间 |
|---|---|
| `周五前`、`6月20日前` | 当天 23:59:59(“前”包含当天) |
| `周五`、`6月30日`(待办) | 当天 23:59:59 |
| `周五下午3点前` | 当天 15:00 |
| 日程只有日期 | 不填开始时间,进入 `unresolved` |
| `尽快` | 不填截止时间 |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test          # node:test,无额外依赖
pnpm build         # tsc → dist/
```

生成调试 patch(把包名换成源码绝对路径),在 DSH 源码目录加载:

```sh
pnpm dev:patch
pnpm dsh web --patch /绝对路径/dsh-todo-distiller/dev.patch.yml
```

`@deepseek-ai/*` 包由宿主提供:放在 `peerDependencies`,同时在 `devDependencies` 镜像(固定 `0.2.2-rc.3`)用于类型检查。设计、架构和决策记录见 `docs/`。

# 设计决策

## 1. 工具内部不调用模型

工具不调用 LLM。我们没有找到工具可用的公开模型调用 API,而且不需要:对话里的模型本来就在,让它读文本再调用工具即可。

## 2. 时间换算由模型完成(曾经相反)

**第一版**:工具里自写了中文时间解析器(今天/明天/周X/月底/N天后等),模型只传 `timeText`。

**问题**:解析器约 300 行规则,需要不断补句式,覆盖面不如模型;而且"自然语言交给模型"本来就是产品原则。

**现行**:模型直接给 ISO 8601 的 `dueAt` / `startAt` / `endAt`,可以合理假设并写入 `timeAssumption`。工具只做模型不擅长或不该花 token 的事:

- 校验格式和先后顺序。
- 回传周几,让日期推算可核对(模型算星期偶尔会错)。
- 生成提醒、保存关联。

**代价**:时间结果取决于模型。因此保留 `timeText` 原文、`timeAssumption` 假设和 `dueWeekday` 核对字段。

## 3. 时区默认 Asia/Shanghai

语料是中文,使用者在中国,只有一个标准时间。参数 `timeZone` 保留,以后国际化时再按用户所在地决定。

## 4. 截止时间约定

- 中文里"周五前"包含周五本身,即周五 23:59:59 之前。
- 只有日期的截止时间是当天 23:59:59。
- 这是模型的自然理解,工具描述里不另做规定。曾误以为"前"不含当天,对话验证后确认模型是对的。

## 5. 提醒规则

- 23:59 的截止时间按"某天之内"处理,当天 09:00 提醒,避免半夜提醒。
- 其他时间提前 15 分钟(可由参数调整)。
- 早于捕获时间的提醒不生成。

## 6. 没有时间的事项不丢

- 待办没有截止时间仍然是合法待办,保留在 `todos`;只有原文写了时间却没能确定时,才同时记入 `unresolved`。
- 日程没有开始时间无法排程,只放 `unresolved`。

## 7. 依赖放置

`dsh-tools`、`cordis` 放 `peerDependencies`,同时在 `devDependencies` 镜像。宿主已提供,放进 `dependencies` 会产生第二份拷贝。`dsh-tools` 版本固定为 `0.2.2-rc.3`,与宿主一致。

## 8. 测试工具

使用 Node 内置的 `node:test`,不引入测试框架。Node 26 可直接运行 `.ts` 文件,源码中相对导入写 `.ts` 后缀,`tsconfig.json` 的 `rewriteRelativeImportExtensions` 让 `tsc` 构建时改写为 `.js`。

## 9. 日程只有日期时不编造时间

日程必须有具体开始时间才能排程和提醒。原文只有日期时,模型不填 `startAt`,事项进入 `unresolved`。这条要求写在工具描述里。曾出现模型填 09:00 占位并因此产生提醒的情况。

## 10. 一个 npm 包,两个插件,一个 preset

安装单位是 bundle(npm 包),不是插件。`@dxsooo/dsh-todo-distiller` 包含提炼插件、提醒事项插件和 `todo-distiller` preset 声明。用户装一次,在界面里选择该 preset。第二个插件通过子路径 `@dxsooo/dsh-todo-distiller/reminders` 引用(`package.json` 的 `exports`)。

## 11. 写入 macOS 用 JXA,经 `ctx.subprocess` 调用 `osascript`

- JXA 是 Apple 的 JavaScript 版 AppleScript,使用同一套 Automation 权限,但日期用真正的 `Date` 对象,避免 AppleScript 日期字符串受系统语言影响。
- 通过 `ctx.subprocess` 启动,不直接用 Node 的 `child_process`,遵守 DSH 的进程管理和沙箱策略。
- 日历事件和提醒事项是两个独立应用,本阶段只写提醒事项。

## 12. 两个工具之间只传 `batchId`

提炼结果保存在插件内存里,写入工具只收 `batchId`(和可选的 `ids`),不让模型把整份数据再传一遍,省 token 也避免传错。代价:重启后批次失效,写入工具返回 `BATCH_NOT_FOUND`,提示重新提炼。

## 13. 默认直接写入,不弹确认

目标体验是拖入文件后自动完成。风险由两点控制:写入专用列表"DSH 助理"(整表可查看、可删除),以及幂等标记(重复执行不产生重复项)。如果以后发现误写入困扰用户,再加确认步骤(DSH 的 `tools/pre-execute` 返回 `ask`)。

## 14. 流程写在 persona,不写在代码

"读文件 → 提炼 → 写入 → 汇报"、时间规则和 `timeAssumption` 约定都在 preset 的 persona 提示词里(`cordis.patch.yml`)。改流程不需要改代码。

## 15. npm 包名使用作用域 `@dxsooo/dsh-todo-distiller`

与 GitHub 账号 `dxsooo` 对齐,不占用全局短名,以后的配套包(如录音入口)可放在同一作用域下。作用域不影响可见性,包仍然是公开的。

最初以无作用域名 `dsh-todo-distiller@0.1.0-rc.1` 发布过一次,随后改名并对旧包执行 `npm deprecate`(npm 官方建议用弃用代替删除)。

不变的内部标识:插件的 `name`(`dsh-todo-distiller`、`dsh-todo-distiller-reminders`)、工具名、preset id、提醒事项备注里的幂等标记前缀 `dsh-todo-distiller:`。它们与 npm 包名无关,改动会影响会话日志和已写入事项的去重。

## 16. 专属页面:每天一个会话,事项库用 storageDomain

- 页面模式仍走 DSH 的会话机制(`ctx.agents`),会话挂在专用工作区“待办助理”下,成为普通会话:可在侧栏查看,用量由 DSH 记录。
- 每天一个会话:当天的文档共用上下文,列表每天只多一条;跨天不共享上下文。
- 跨天关联不靠压缩或模型写的 memory,而是由代码维护事项库,下一步把未完成事项的索引注入新会话(详见 `page.md`)。
- 事项库用 DSH 的 `ctx.storageDomain`(默认 JSON 后端,可改配置换 SQLite),不自己处理原子写和多进程。
- 聊天模式的 preset 已移除。处理完直接写入提醒事项,是否加确认步骤按使用反馈再定。

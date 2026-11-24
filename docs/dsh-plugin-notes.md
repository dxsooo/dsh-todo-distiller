# DSH 插件开发入门笔记

面向第一次写 DSH 插件的人。以下内容来自 DSH 源码(`deepseek-harness`,版本 `0.2.2-rc.5`)和本项目实际踩过的坑。官方参考:DSH 仓库的 `docs/user/develop/basic/tool.md` 和 `docs/cookbook/adding-a-tool.md`。

## 插件长什么样

一个模块,导出三样东西:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'          // 加载诊断里显示的名字
export const inject = ['tools']          // 依赖的服务,等它就绪后再执行 apply
export function apply(ctx: Context) {    // 入口,宿主传入 ctx
  // 注册工具、监听事件……
}
```

- 加载顺序由 `inject` 决定,不是文件顺序。
- 通过 `ctx` 做的注册(工具、事件监听)是 effect:插件卸载时自动清理。自己持有的资源(定时器、连接)要用 `ctx.effect(() => { ...; return cleanup })` 包起来。
- `@deepseek-ai/cordis` 在插件里只用 `import type`,运行时由宿主提供。

## 注册一个工具

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'tool_name',            // 模型调用时用的名字
  description: '...',           // 模型看到的说明
  parameters: { text: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },                       // 返回值的 schema
    render: (_args, value) => [{ type: 'text', text: value }],  // 给模型看的内容
  },
  async execute(args, exec) { return '...' },          // 只返回符合 output.schema 的 JSON 值
}))
```

要点:

- `execute` 返回的是**数据**,不是文字。`render` 负责把数据变成模型看到的内容。
- 参数在 `execute` 前自动校验,类型由 schema 推导。DSL 表达不了的约束(非空字符串、数值范围)要自己检查,失败时抛 `ToolArgsError`(从 `@deepseek-ai/dsh-tools` 导入),模型会看到具体错误并可重试。
- 工具失败请抛 `HarnessError` 的子类,不要抛普通 `Error`。
- `exec.signal` 是取消信号,耗时操作要响应它。

## schema 的写法与坑

支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、`oneOf`(以及 `enum`)。

| 坑 | 做法 |
|---|---|
| 每个 `object` 必须写 `additionalProperties: true/false`,否则加载时报错 | 总是显式写 |
| 参数默认可选,必填要加 `required: true` | 输出里每个字段也标 `required: true`,这样类型里不会变成可选 |
| 可空字段 | `{ oneOf: [{ type: 'string' }, { type: 'null' }] }`,没有 `nullable` 写法 |
| TypeScript 把 `enum: ['a','b']` 推成 `string[]`,类型对不上 | 字面量用 `as const`;写辅助函数时泛型用 `<const S extends ValueSchemaSpec>` |
| 只返回 `undefined` 的字段 | 输出 schema 是严格校验的,可空字段要输出 `null`,不要省略 |

本项目的 `src/index.ts` 里有 `nullable()`、`req()` 两个辅助函数,可以直接参考。

## 调试:用 `--patch` 加载

不需要安装或发布插件。本项目用 `pnpm build && pnpm dev:patch` 生成 `dev.patch.yml`(包名换成 `src/app.ts` 的绝对路径),然后在 DSH 源码目录运行:

```sh
pnpm dsh web --patch /绝对路径/dsh-todo-distiller/dev.patch.yml
```

patch 的格式:

```yaml
- insert:
    - id: todo-distiller
      name: '/绝对路径/dsh-todo-distiller/src/app.ts'
```

打开 `http://127.0.0.1:3080`。

- `name` 必须是**绝对路径**,可以直接指向 `.ts` 文件,不用先构建。
- 没有"启用"按钮:写进 `cordis.yml` 的插件在启动时就加载,工具自动对模型可见。
- 改了代码后重启这个命令,不要只刷新页面。浏览器那一半加载的是打包后的 `dist/client.js`,改了 `src/client` 要先 `pnpm build`。
- 参数顺序:`--patch <文件>` 要紧跟在 `web` 后面,写在 `--no-open` 前。
- 不想自动打开浏览器,加 `--no-open`。
- `--patch` 只加载代码,**不会安装依赖**。插件需要的包必须写进插件自己的 `package.json` 并在插件目录执行 `pnpm install`。

## 依赖

- `@deepseek-ai/*` 是宿主提供的核心包:放 `peerDependencies`,同时在 `devDependencies` 写同样版本,用于 IDE 类型提示。不要放 `dependencies`,会装出第二份。
- `@deepseek-ai/dsh-tools` 的 npm `latest` 标签指向过期版本,真正的版本线在 `next` 标签。本项目固定为 `0.2.2-rc.5`,与宿主一致。不要直接 `npm i @deepseek-ai/dsh-tools`。
- 所有 `@deepseek-ai/dsh-*` 包保持同一个版本线。

## 打包成 bundle(将来)

`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`,patch 里按**包名**(不是路径)引用插件:

```yaml
- insert:
    - id: dsh-todo-distiller
      name: '@dxsooo/dsh-todo-distiller'
```

用户用 `dsh plugin add` 安装后,该层随 profile 生效。本阶段不使用。

## 环境

- Node 要求 `^22.19.0` 或 `>=24`。本机是 Node 26,可直接运行 `.ts`。
- 命令参数顺序:`pnpm dsh web --patch <文件> --no-open` 可用;`pnpm dsh web --no-open --patch ...` 会报 `unknown option '--patch'`。

## 补充:preset、配置、子进程

**preset**:`@deepseek-ai/dsh-agent-preset` 行声明 `id`、`name`、`description`、`plugins`(子插件列表)。选了该 preset 的会话只看到它列出的工具和提示词。`@deepseek-ai/dsh-persona` 子插件设置系统提示词;`complete: true` 表示提示词只用 `prefix`。`disabled: !!js process.platform !== 'darwin'` 可按平台停用子插件。参考 DSH 仓库 `packages/bundle/web-app/presets/*.patch.yml`。

**一个包多个插件**:`package.json` 的 `exports` 增加子路径,patch 里写 `包名/子路径`。DSH 自带的 `@deepseek-ai/dsh-plugin-manager/tools` 就是这种写法。

**插件配置**:导出 `Config` 接口和同名的 Schemastery schema(`import Schema from '@deepseek-ai/schemastery'`),`apply(ctx, config)` 收到已校验、已填默认值的配置。可调的值(列表名、超时)都放配置里。

**子进程**:`inject` 里加 `'subprocess'`,用 `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, signal })`。所有字段显式给出,无默认值;`stdout: { maxBytes }` 收集输出,`handle.done` 等待退出,`handle.collected.stdout.readFrom(0).text` 读取。类型来自 `@deepseek-ai/dsh-subprocess`(peer + dev 依赖)。

**文件附件**:拖入对话框的非图片文件按原样保存,模型收到一行说明和保存路径,需要内容时用文件读取工具读取。音频、视频没有专门处理。

## 补充:专属页面插件(本项目 0.1.0-rc.2 起的形态)

以下用法从 DSH 源码和社区插件 `dsh-media-desk`、`dsh-minigames` 读出,**不在 DSH 的插件开发公开文档里**,升级 DSH 时要重新验证。

**一个包同时有服务端和浏览器两半**:`package.json` 里 `dsh.client: { platform: 'web' }`,`exports["./client"]` 指向浏览器模块。bundle patch 里只插入包名一行。

**浏览器模块格式**:`window.__ModuleLoader__.load({ id: 包名, factory(require) { ...; return module.exports } })`,`id` 必须等于包名。`require` 只能取宿主的平台模块:`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-primitives` 等(完整列表见 DSH `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`),其余打进包里。本项目用 esbuild,见 `scripts/build-client.mjs`。

**侧栏入口和页面**:浏览器插件 `inject: ['slots']`,同一个 id 注册两处:`slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id, order, label }, Icon))` 和 `slots.inject('main', () => slots.register({ name: 'main', key: id }, Page))`。图标用 `@deepseek-ai/dsh-client-ui-primitives` 里的 `Icon*OutlineRegular`,和 DSH 其他入口风格一致。

**服务端路由**:`ctx.webServer.register({ kind: 'prefix', path: '/xxx', handler })`。默认要求登录(`auth: 'required'`),未登录返回 401,不用自己鉴权。浏览器端用相对路径 `fetch('xxx/...')`。

**在插件里跑一个会话**:`ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: ctx.agentDefaultModel.currentSelection(), setup(agentCtx) { ... } })`,`agent.followup(createUserMessage(...))` 后 `await agent.whenIdle()`。要让会话持久化并出现在侧栏,先 `ctx.workspaceRegistry.create(dir, title)`,再 `workspace.attachSession(sessionId)`,不要 `dispose()`(dispose 会删除会话)。重启后用 `ctx.agents.resume({ resumeSessionId, setup })` 接着用。参考 DSH 的 `packages/experimental/webhook/src/session.ts`。

**Agent 作用域**:`setup(agentCtx)` 里注册的工具、系统提示词、`tools.restrict({ allow: [] })`(隐藏全局工具)、`systemPrompt.suppressRuntimeContext()` 只影响这个会话。**坑**:Agent 上下文不会注入插件 `inject` 里声明的服务,在 `agentCtx` 上读 `subprocess` 会报 `cannot get property "subprocess" without inject`。要用服务,从插件自己的 `ctx` 取。

**存储**:`ctx.storageDomain.open(defineDomain({ name, version, tables: { t: domainTable(zodSchema) } }))`,读同步、写落盘。默认 JSON 后端,文件在 `~/.dsh/storages/<name>.json`。`zod` 作为 peer 依赖,用宿主那份。

**token 用量**:`assistant/message` 事件的 `data.usage`(`inputTokens` 不含缓存,另有 `cacheReadTokens`、`outputTokens`)。

**Node 跑 `.ts` 的限制**:Node 只做类型擦除,不支持构造函数参数属性(`constructor(private x)`)等需要编译的语法,测试会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。

**pnpm 构建脚本**:esbuild 需要跑安装脚本,pnpm 默认拦截。在 `pnpm-workspace.yaml` 里写 `allowBuilds: { esbuild: true }`。

## 补充:桌面版

- 插件页面里,从 npm 安装的插件详情页有“版本”一节,可以直接更新。预发布版本默认不提示,要点“显示预发布版本”。
- 命令行方式:先完全退出桌面版,再 `dsh plugin --profile desktop add <包>@<版本或标签>`,然后重新打开。没有全局 `dsh` 时,用应用包里的 `Contents/Resources/runtime/cli/bin/dsh`。
- macOS 的“控制提醒事项”授权对象是启动 DSH 的应用:Web 版是终端,桌面版是桌面应用。

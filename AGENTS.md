# AGENTS.md

`@dxsooo/dsh-todo-distiller`:DeepSeek Harness(DSH)的“待办助理”bundle。侧栏页面接收拖入的文档,在每天一个的 DSH 会话里由模型提炼待办和日程,写入 macOS 提醒事项。

先读 `docs/README.md`,再按任务读 `docs/` 里的对应文档。DSH 源码在同级目录 `../deepseek-harness`(当前 0.2.2-rc.3),API 以源码为准。

## 原则

- 自然语言理解交给模型;校验、时间换算核对、提醒计算、去重、存储由代码完成。
- 不修改 DSH 源码。确需改宿主时先停下来说明原因和替代方案。
- 依赖尽量少。`@deepseek-ai/*` 和 `zod` 由宿主提供:`peerDependencies` + `devDependencies` 镜像,不放 `dependencies`。
- 页面文案遵守用户的界面规则:不加说明文字和辅助文案,保留必要的可访问名称。
- 文档只记录当前状态,改了行为同步改 `docs/`;决策写进 `docs/decisions.md`。

## 命令

```sh
pnpm install
pnpm typecheck     # Host 和浏览器两套 tsconfig
pnpm test          # node:test,直接跑 .ts(不支持构造函数参数属性等需编译的语法)
pnpm build         # tsc → dist/,esbuild → dist/client.js
pnpm dev:patch     # 生成 dev.patch.yml
# 在 ../deepseek-harness 运行:
pnpm dsh web --patch /绝对路径/dsh-todo-distiller/dev.patch.yml
```

改了 `src/client` 要先 `pnpm build`,`--patch` 加载的是打包后的浏览器模块。

## 不要做

- 不要从代理进程往用户的提醒事项里写东西;需要测写入时让用户在自己启动的 DSH 里验证,或用配置 `writeReminders: false`。
- 不要改事项 id / 去重标记的计算(`src/item-id.ts`),会导致已写入的提醒重复。
- 不要改工具名、插件 `name`、事项库的域名和表名,会影响已有会话和数据。
- 不要执行 `npm publish`;发布需要用户在浏览器里完成 2FA。流程见 `docs/release.md`。
- 启动或结束 `dsh web` 进程前确认端口,不要杀掉用户自己的 DSH(默认 3080,自测用其他端口和临时 `DSH_HOME`)。

## 分支

`dev` 开发,发布时 `master` 快进合并并打 `v<版本>` 标签。推送用 SSH;仓库级 git 身份 `dxsooo <zeohan.dxs@gmail.com>`。

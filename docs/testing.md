# 测试与验证

## 自动化测试

在插件目录运行:

```sh
pnpm install
pnpm typecheck     # 类型检查
pnpm test          # node:test,26 个用例
pnpm build         # tsc → dist/,esbuild → dist/client.js
```

覆盖内容:

- 时间辅助函数:无偏移时间按时区解释、显式偏移保留、日期-only 和乱写被拒绝、周几。
- `validate`:非法时间、字段用错、结束早于开始、key 重复。
- 三个中文样例:会议纪要(含关联、提醒)、微信消息(含来源信息)、文档大纲(含没有时间的日程)。
- 时长推算结束时间、过去时间的警告和提醒跳过。
- 提醒事项映射:截止/提醒时间、优先级、备注、去重标记稳定;从事项库重建的提醒与原始写入一致。
- 事项库投影、事项稳定 id(与已写入的去重标记保持一致)、跨文档关联、已有事项索引的选择与渲染。
- `osascript` 参数构造和授权错误识别。

自动化测试不覆盖"模型是否填对时间"和页面、会话、写入提醒事项的真实运行,这些用下面的端到端步骤验证。

`src/app.ts`、`src/runner.ts`、`src/client/` 没有单元测试,它们依赖 DSH 宿主服务。

## 端到端:拖入文件写入提醒事项

前置:macOS,`pnpm install` 已执行。

1. 生成调试 patch 并启动(在 DSH 源码目录):

   ```sh
   (cd /path/to/dsh-todo-distiller && pnpm build && pnpm dev:patch)
   pnpm dsh web --patch /path/to/dsh-todo-distiller/dev.patch.yml
   ```


2. 打开 `http://127.0.0.1:3080`,点侧栏的"待办助理"。
3. 把 `test/fixtures/项目周会-2025-06-03.md` 拖进页面,不需要发送。
4. 首次写入时 macOS 会弹出"想要控制提醒事项"的授权框,点"好"。授权对象是启动 DSH 的应用(终端)。

预期:

| 项 | 结果 |
|---|---|
| 提醒事项里出现列表"DSH 助理" | 是 |
| 提交预算表 | 截止 6月6日 23:59,提醒 6月6日 09:00,负责人张伟 |
| 预算评审 | 6月9日 14:00(待办或日程,取决于模型判断) |
| 联系供应商 | 无截止时间 |
| 需求冻结 | 6月20日 23:59 |
| 项目周会 | 6月11日 10:00,备注含 11:30 结束、3号会议室 |
| 上线评审 | **不**出现在提醒事项,卡片里标为未确定 |
| 再拖一次同一个文件 | 不产生重复项,卡片显示"已存在" |

清理:在提醒事项 app 里删除列表"DSH 助理"。

### 自动化测试没有覆盖的部分

JXA 脚本的流程用替身对象验证过,但 `Application('Reminders')` 的真实行为(列表创建、日期、提醒时间、备注查重)只能在真机上验证。

## 不写提醒事项的测试

在 `dev.patch.yml` 的 `todo-distiller` 行加配置,只提炼和记录:

```yaml
- insert:
    - id: todo-distiller
      config:
        writeReminders: false
      name: '/绝对路径/dsh-todo-distiller/src/app.ts'
```

可以在页面里 `fetch('todo-distiller/runs', { method: 'POST', headers: { 'x-todo-distiller-name': encodeURIComponent('a.md') }, body })` 提交,`GET todo-distiller/runs` 读结果。

## 安装包验证(发布前)

```sh
pnpm build && npm pack --pack-destination /tmp/pack
# DSH 源码目录,临时 DSH_HOME,不碰真实 profile:
DSH_HOME=/tmp/dsh-home-x pnpm dsh plugin --profile web add /tmp/pack/dxsooo-dsh-todo-distiller-<版本>.tgz
DSH_HOME=/tmp/dsh-home-x pnpm dsh web --port 0 --no-open
```

确认侧栏有"待办助理"、`todo-distiller/ping` 返回 200、无 `MODULE_NOT_FOUND`,然后删除 `/tmp/dsh-home-x`。

## 已验证的环境

- DSH 0.2.2-rc.3 源码,Web 版,`--patch` 和安装包两种方式。
- 桌面版:用户实测 rc.2 发现写入失败(已在 rc.3 修复);rc.3 在桌面版上的写入待用户确认。

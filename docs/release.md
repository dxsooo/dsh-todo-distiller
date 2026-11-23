# 发布流程

## 约定

| | 说明 |
|---|---|
| 分支 | `dev` 开发;发布时 `master` 快进到 `dev` |
| 版本 | 正式版前用 `0.1.0-rc.N` |
| git 标签 | `vX.Y.Z-rc.N`,打在发布提交上 |
| npm 标签 | `next` 开发版(每个 rc);`latest` 正式版(只在发正式版时移动,目前暂指 `0.1.0-rc.3`) |
| npm 包 | `@dxsooo/dsh-todo-distiller`,公开。旧的无作用域包 `dsh-todo-distiller` 已弃用 |

## 步骤

1. 在 `dev` 上改 `package.json` 的 `version`,更新 README 和 `docs/`。
2. 检查:`pnpm typecheck && pnpm test && pnpm build`。
3. 安装包验证:见 [testing.md](testing.md#安装包验证发布前)。
4. 提交、合并、打标签、推送:

   ```sh
   git checkout master && git merge --ff-only dev
   git tag -a v<版本> -m "<版本>"
   git push origin master dev v<版本>
   git checkout dev
   ```

5. 发布(需要在浏览器里用 Touch ID 完成 2FA,必须在自己的终端里执行):

   ```sh
   npm publish --tag next --access public --registry=https://registry.npmjs.org
   ```

6. 发正式版时再移动 `latest`:

   ```sh
   npm dist-tag add @dxsooo/dsh-todo-distiller@<版本> latest --registry=https://registry.npmjs.org
   ```

## 注意

- npm 默认指向镜像 `registry.npmmirror.com`,发布和查询都要带 `--registry=https://registry.npmjs.org`。
- 账号用安全密钥(Touch ID)做 2FA。不要用“绕过 2FA”的令牌,npm 计划在 2027 年 1 月取消它的直接发布能力。
- 同一个版本号发布后不能再用,即使删除也不行。
- git 推送用 SSH(`git@github.com:dxsooo/dsh-todo-distiller.git`),仓库级身份 `dxsooo <zeohan.dxs@gmail.com>`。

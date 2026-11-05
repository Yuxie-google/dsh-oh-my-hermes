# 开发与验证

运行环境：Node.js >= 22.15，DSH >= 0.2.0-rc.1 且 < 0.3.0。插件没有运行时第三方依赖，前端使用宿主提供的 React，无需构建。

```sh
npm run check
npm test
npm pack
```

安装生成的 `.tgz` 后重启 DSH，进入「设置 → 远程 Hermes」添加自己的 SSH 主机。开发目录不直接作为本机安装目录；使用新版本安装包升级，避免旧 tarball 的完整性缓存。

单元测试使用临时目录与模拟 SSH，不会访问真实主机。可选浏览器回归见 README；需要自己提供 Playwright、Chromium、marked 和 React 18 UMD 文件，截图保存在被 Git 忽略的 `.preview/` 中。

真实远端冒烟测试需要显式设置 `HERMES_SSH_HOST`，可选设置 `HERMES_SSH_USER`、`HERMES_COMMAND` 和 `HERMES_REMOTE_CWD`。它们会通过 SSH 调用自己的 Hermes，可能消耗模型额度；`smoke-profiles.mjs` 还会创建并清理专用临时身份。请仅针对自己的测试环境运行。

提交时保留第三方许可说明，不提交本机配置、SSH 私钥、访问令牌、对话存储、备份或生成截图。

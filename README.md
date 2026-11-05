# Oh My Hermes for DeepSeek Harness

![Hermes icon](icon.svg)

**通过 SSH 将远程 Hermes Agent 集成到 DeepSeek Harness。**

当前版本 **1.9.4**。改动和升级注意事项见 [CHANGELOG.md](CHANGELOG.md)。

Oh My Hermes 是 DeepSeek Harness（DSH）的模型提供方插件，包名为 `dsh-oh-my-hermes`。用户可在 DSH 对话界面中选择远程 Hermes 身份与模型、浏览可用技能，并查看流式回答和工具执行过程。

请求通过 SSH 发送至远端 Hermes Agent。模型调用、工具执行、技能加载与记忆管理均在远端完成；插件负责消息传输、结果展示及会话续接。

- **多主机与多模型**：在设置页管理 SSH 主机，读取远端模型目录并配置对话中的可选模型。
- **身份管理**：创建、复制和绑定原生 Hermes profile，为不同身份维护独立的续接关系。
- **技能入口**：按当前身份读取技能目录，支持搜索及将技能使用提示加入输入框。
- **工具过程展示**：以可折叠摘要展示工具调用与结果，保留命令、输出换行、执行状态和耗时。

```
dsh agent loop
   └─ HermesAdapter  (lib/index.js)
        └─ ssh ubuntu@host  "cd '/home/ubuntu' && '/home/ubuntu/.local/bin/hermes' -p '<profile>' chat \
                              --query-file - -Q --format stream-json [--resume <id>] [-m <model>] [--reasoning <e>]"
             └─ Hermes Agent（远端：它自己的模型、工具、技能、记忆）
```

## 功能与协议映射

| 方向 | 映射 |
|---|---|
| 提示词 | dsh 的这一轮文本 → 远端 stdin（`--query-file -`），**不进 shell** |
| 流式文本 | `{"type":"text"}` 帧 → `block-start` / `text-delta` / `block-end` |
| 远端工具 | `tool_use` / `tool_result` 帧 → **只读 Markdown 展示块**，摘要默认折叠、命令/输出使用代码块，dsh 不会去执行它们 |
| 用量 | `result.tokens` → `usage`（input / output / cache_read / cache_write） |
| 结束 | `result.exit_code` + ssh 退出码 → `finish`（`stop` / `error` / `aborted`） |
| 会话 | 远端 `session_id` 按 dsh 会话存档，下一轮自动 `--resume`；dsh 重启后也从状态文件恢复 |
| 取消 | 中断信号 → 杀掉本地 ssh，立即以 `aborted` 收尾 |
| 超时 | 总时长（默认 30 分钟）与静默（默认 10 分钟）双保险，超时即杀 |

服务端仅依赖 Node.js 内置模块，通过适配器实现 DSH 的模型提供方接口；前端复用宿主提供的 React 和界面插槽，无需额外构建。

## 安装与卸载

```powershell
git clone https://github.com/Yuxie-google/dsh-oh-my-hermes.git
cd dsh-oh-my-hermes
npm pack
dsh plugin --profile desktop add ./dsh-oh-my-hermes-1.9.4.tgz
```

安装后 `package.json` 的 `dsh.profile.bundles` 会多出 `dsh-oh-my-hermes`，**重启 dsh** 生效。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-oh-my-hermes
```

首次安装后先打开「设置 → 远程 Hermes」添加 SSH 主机；安装包不附带任何真实服务器地址。开发与验证说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 配置说明

配置写在插件自带的 [cordis.patch.yml](cordis.patch.yml)；也可以在自己的 profile 的 `cordis.patch.yml` 里用同一个 `id: oh-my-hermes` 覆盖，这样升级插件不会冲掉设置：

```yaml
- id: oh-my-hermes
  config:
    hosts:
      - id: hermes-remote          # provider 路由名，出现在模型选择器
        name: '远程 Hermes'         # 分组显示名
        sshHost: '203.0.113.10'  # 必填
        sshUser: 'ubuntu'          # 留空则用 ~/.ssh/config 的 Host 条目
        command: '/home/ubuntu/.local/bin/hermes'
        remoteCwd: '/home/ubuntu'
    models:
      - id: hermes                 # dsh 里选的那个 id
        name: '远端默认模型'         # 选择器里显示的名字
        contextWindow: 200000      # 只影响 dsh 的上下文环与压缩阈值
        maxTokens: 32000
        # hermesModel: 'anthropic/claude-sonnet-4'   # 传 -m，不填就是远端默认
        # hermesProfile: 'coder'   # 选择远端 Hermes 身份，留空则固定为 default
```

其余可选键：

| 键 | 默认 | 说明 |
|---|---|---|
| `sshCommand` | Windows 用 `System32\OpenSSH\ssh.exe`，其余 `ssh` | ssh 可执行文件 |
| `sshArgs` | `[]` | 追加给 ssh，如 `['-i','C:/keys/id_ed25519']`、`['-p','2222']` |
| `extraArgs` | `[]` | 追加给 `hermes chat`，如 `['--yolo']` |
| `maxTurns` | `0` | >0 时传 `--max-turns` |
| `turnTimeoutMs` | `1800000` | 单轮总时长上限 |
| `idleTimeoutMs` | `600000` | 无输出多久算卡死 |
| `toolActivity` | `true` | 是否展示远端工具调用与结果 |
| `maxToolText` | `2000` | 单条工具调用或结果详情的字符上限，最多 18 行；截断时明确提示 |
| `stateDir` | `~/.dsh/oh-my-hermes` | 会话映射存放目录 |
| `persistSessions` | `true` | 关掉则重启 dsh 后不续接远端会话 |
| `debug` | `false` | 把每次 ssh 调用打到 stderr（没有 logger 时） |
| `env` | `{}` | 追加给子进程的环境变量 |

**多主机**：`hosts` 里每一项都会变成模型选择器里一个独立的 provider（`id` 不能重复），一个插件实例可以同时挂几台机器，各自有各自的模型行。

## 消息流与工具展示

Hermes 的 `--format stream-json` 是**换行分隔的 JSON 帧**，插件把它翻译成 dsh 的 `StreamChunk`：

| Hermes 帧 | 变成 |
|---|---|
| `system{init,model}` | 不显示；模型名进 debug 日志（换模型时的实际证据） |
| `text` | `text` 块（`block-start` → `text-delta` → `block-end`） |
| `tool_use` | 独立 text 块：带专用标记的工具摘要 + 安全的 Markdown 代码块，命令按 bash、其它参数按 JSON 展示 |
| `tool_result` | 独立 text 块：完成/失败、工具名、耗时 + 保留换行与缩进的输出；拆掉 JSON 信封，非零 exit 或 `error` 记为失败 |
| `result` | `usage`（token 计数）+ `finish`（停止/错误） |

参考 oh-my-claude 的工具 Markdown 展示方式，工具调用和结果各自形成独立文本块，按事件顺序与正文交错，不再放进“思考”区域。前端只识别专用标记与相邻原生 `.md-code-block` 组合，将详情默认收起；点击摘要或按 Enter / 空格展开，失败摘要单独标识。命令、输出中的反引号不会破坏代码围栏，正文中的普通工具引用和代码块不参与折叠。命令使用宿主的 Markdown 代码高亮；长详情最多 18 行及 `maxToolText` 字符，显示截断提示。

**远端工具不会变成 `tool-call` 块**：dsh 见到 `tool-call` 会在本地执行它。Hermes 的工具在远端跑，插件只发送展示文本。诊断错误仍可使用 reasoning 块。

工具展示与模型输出格式无关，由插件代码确定。最终回答原样保留 Markdown 和换行，不自动重写为表格或改写内容。新版消息的标记随文本存入历史，重新打开后可恢复折叠；旧版已保存的 reasoning 展示保持原样。客户端折叠依赖宿主当前 Markdown DOM 结构，不匹配或插件未加载时，仍可阅读普通摘要和代码块，不会丢失详情。

没见过的帧类型会**只警告一次**（`unhandled hermes frame "x"; stream-json schema may have changed`），这样 Hermes 协议变了会吭声而不是静默吞掉输出。

## 对话快捷指令

加载插件并重启 DSH 后，在对话输入框输入 `/hermes`，原生 `/` 菜单会列出：

| 指令 | 功能 |
|---|---|
| `/hermes` | 查看帮助 |
| `/hermes-status [主机 id]` | 查看当前 DSH 对话的 Hermes 续接、运行状态及保存方式 |
| `/hermes-models [主机 id]` | 列出已配置模型；实际切换仍使用输入框的模型选择器 |
| `/hermes-hosts` | 列出可用主机及其模型数量 |
| `/hermes-profiles [主机 id]` | 查看已接入的身份与对应模型行，提示 profile 创建入口 |
| `/hermes-skills [主机 id] [profile]` | 通过 SSH 读取指定或会话已记录身份的可用技能名称、简介和分类，不调用模型 |
| `/hermes-reset [主机 id]` | 重置本对话的续接关系；下一轮携带 DSH 文本历史重新建立远端会话 |

也可以输入 `/hermes status`、`/hermes models`、`/hermes profiles`、`/hermes skills`、`/hermes hosts` 或 `/hermes reset`。

这些指令不消耗模型额度。除 `/hermes-skills` 需要通过 SSH 读取真实远端技能目录外，其余指令均为本地操作。`/hermes-profiles` 和 `/hermes-models` 是只读列表：只有一个主机时，不论当前选中 DeepSeek、Claude 还是 Hermes，也不论是否已开始对话，均可直接回车执行。输入框中灰色的 `[主机 id]` 是可选参数提示，不需要照着输入。多个主机且路由尚不明确时请指定 id，例如 `/hermes-profiles hermes-remote`。会话状态和重置指令按当前会话的 Hermes 路由处理；最近使用其它提供方时，需显式指定 Hermes 主机，防止误操作旧映射。

`/hermes-skills` 优先按会话已记录的模型行确定身份；尚未发送消息、刚切换模型或身份不明确时，建议显式使用 `/hermes-skills hermes-remote coder`。不明确时不会擅自选择 default。输入框旁的技能面板直接订阅当前模型选择，不依赖上一轮的会话映射。

重置保留 DSH 历史和远端原会话；运行或排队中的会话需先停止再重置。指令是插件的本地管理操作，不是 Hermes 终端交互命令的通用转发。

Hermes 指令完成后，输入框上方会显示本会话的「命令结果」卡片，成功和失败都会显示，包括尚未开始普通对话的新会话首页。卡片可关闭，只保留当前会话最近一次 Hermes 指令的即时结果；不会显示其它会话的输出。刷新页面后需重新执行指令。DSH 自己的命令日志仍由宿主保存。

## 图形界面

### 对话中的技能入口

选择远程 Hermes 模型后，输入框底部工具栏的「工作区内修改」旁显示「技能」按钮。点击后在按钮上方弹出面板，面板标题显示当前身份；首次打开通过 SSH 读取此模型行绑定身份的原生技能目录。可搜索名称、简介或分类，并手动刷新；没有技能、读取失败、重试和搜索无结果均有提示。支持键盘打开、Esc 和点击外部关闭，面板随窗口大小调整，使用浏览器顶层弹出层避免被输入框裁剪。其它提供方不显示这个入口，切换模型或身份后清除旧列表，过期请求不会覆盖新身份。

点击「加入输入框」会保留现有草稿，添加要求远端先用 `skill_view` 加载所选技能的提示。补充任务后由用户发送，不自动调用模型或执行技能。实际技能是否被使用，以远端返回的工具活动为准；读取到技能不代表其外部服务、凭据或依赖均已配置。

目录调用远端 Hermes 的 `resolve_profile_env` 和 `skills_list()`，沿用其禁用、平台、项目可信度及去重规则，包含原生插件提供的技能元数据。只返回名称、简介和分类，不读取技能正文到前端。工作目录与实际对话的 `remoteCwd` 一致。需要远端 Python3、可解析的 Hermes Python 启动入口及兼容的原生 API；无法解析或版本不兼容时显示错误，不改用其它身份的目录。当前在 Hermes Agent v0.22.6 验证通过。

### 创建和接入 Hermes 身份

此流程参考 `ds-bot 0.2.0` 的命名、职责和模型选择方式，管理的对象是远端原生 Hermes profile。

1. 打开「设置 → 远程 Hermes」，在对应主机下点击「读取 profiles」。
2. 已有身份可直接「添加为模型行」。需要新身份时，点击「创建 profile」。
3. 填写名称和用途简介，选择空白创建或从已有 profile 复制。可选填长期指令，写入**新身份**的 `SOUL.md`；用途简介仅是身份元数据。
4. 点击「在远端创建并添加」。创建立即在远端生效，并在本页草稿中添加一条该身份的默认模型行。
5. 点击「保存配置」，回到对话输入框，在模型选择器中选择如 `coder · 默认模型` 的行。已有主机增加模型行无需重启。

复制使用 Hermes 的 `--clone-from`，会继承来源的配置、模型凭据、技能和身份资料，包含其精选记忆；不会复制消息渠道，也不会改远端的全局默认 profile。长期指令留空时保留新建或复制后的身份设置。外部记忆服务仍使用复制后的连接配置。空白创建的身份需在远端运行 `hermes -p <名称> setup` 配置凭据。

撤销页面草稿不会删除远端已创建的身份；请求中断或超时后应先刷新列表，确认创建结果。同名创建由远端 CLI 拒绝，不覆盖现有身份。本插件不提供删除远端 profile 的入口。

模型行新增 `hermesProfile` 字段。未填写时明确使用 `default`，不会跟随远端 `profile use` 改变；每轮通过 `hermes -p <名称> chat ...` 执行。指定其它模型时 `-m` 仍只覆盖该轮所用模型。不同身份的续接指纹不同，本插件内同一 SSH 目标的同一身份会排队执行。

模型选择器会在命名身份的模型前加上身份名，例如 `coder · deepseek-v4.1-flash-1017`。已有的 `coder · 默认模型` 名称不会重复加前缀，模型路由 id 保持不变。模型行中的「使用身份」下拉选择已有身份；创建新身份请使用上方的「创建 profile」，并保存新增的独立模型行。

**身份需要各自独立对话时，请为每个身份新建一个 DSH 会话。** 在同一个 DSH 会话中切换身份，会携带该对话的文本历史建立新的远端会话；不会复用前一个身份的远端会话 ID。

每行自动读取所选身份的模型缓存。复制的身份尚无缓存且模型配置与 default 相同时，可借用 default 的候选列表，并显示来源；此检查使用远端 Python3 / PyYAML，不返回配置或凭据。其它情况下可在远端运行 `hermes -p <名称> model` 刷新缓存，或在高级设置输入自定义远端模型。Profile 列表和长期指令写入使用远端 Python3，支持标准 Hermes home 布局（`~/.hermes`，或 SSH 环境中的 `HERMES_HOME` 根目录）。

### 主机与模型配置

设置 → **远程 Hermes**（客户端插件，纯 JavaScript、无需构建，`lib/client.js`）：

- **主机卡片**：路由 id、显示名、sshHost、sshUser、hermes 路径、远端工作目录；每张卡带「测试连接」——它执行 `ssh <host> '<hermes> --version'`，只验证 SSH 与路径，**不消耗模型 token**。
- **模型行**：先下拉选择「使用身份」，再选择「远端模型」，可修改显示名称。选择「身份默认模型」时不覆盖该身份的默认模型。切换身份会清除旧模型覆盖，保留自定义显示名。
- **高级设置**：收纳本地模型 id、上下文窗口、最大输出和自定义远端模型。新增行自动生成唯一 id，修改下拉选择不会改变已有 id。
- **模型发现**：自动读取并共享同一身份的候选列表，可手动刷新；失败保留当前选择并提供重试。批量添加入口折叠收纳，选定身份后可点模型芯片添加多行。
- 保存写入 `~/.dsh/oh-my-hermes/config.json`：只改模型行时**立即生效**；增删主机才需要重启 dsh（provider 在启动时注册）。
- 该文件覆盖插件 patch 里写的 `hosts`/`models`；删掉它就回到 patch 的配置。
- 未保存时显示状态，可撤销修改；请求超时或加载失败后可以重试。修改模型 ID 时保留输入焦点；支持窄屏和键盘操作。
- **会话续接与诊断**：查看 DSH / Hermes 会话映射、模型、活动进程和排队状态；「重置续接」仅清除本地映射，下一轮会携带 DSH 文本历史重新建会话。正在运行或排队的会话禁止重置。列表通过「刷新会话」更新。

页面使用的宿主路由（挂在 dsh 自带 web server 上，走同一个登录校验）：

| 路由 | 作用 |
|---|---|
| `GET /dsh-oh-my-hermes/config` | 返回当前生效的 hosts 与各自模型行、配置文件路径 |
| `PUT /dsh-oh-my-hermes/config` | 校验、写入，并在主机集合不变时**即时生效** |
| `GET /dsh-oh-my-hermes/models?host=…&profile=…` | 读所选身份的模型缓存；符合条件时借用 default 缓存，响应以 `sourceProfile` 标明来源 |
| `GET /dsh-oh-my-hermes/skills?host=…&model=…` | 按已保存模型行解析身份，读取其实际可用技能元数据；不接受任意 SSH 目标或 profile 覆盖 |
| `POST /dsh-oh-my-hermes/test` | 对一台主机跑 `--version` 探测 |
| `GET /dsh-oh-my-hermes/sessions` | 续接映射、进程及协议诊断，不返回对话正文或凭据 |
| `DELETE /dsh-oh-my-hermes/sessions` | JSON `{ "provider": "hermes-remote", "sessionId": "…" }`，重置该会话本地续接映射 |
| `GET /dsh-oh-my-hermes/profiles?host=…` | 读取该主机的 profile 名称与活动标记；也可传 `sshHost` / `sshUser` 读取表单中的目标 |
| `POST /dsh-oh-my-hermes/profiles` | JSON `{ host: { id 或 sshHost/sshUser/command }, name, cloneFrom?, description?, instructions? }`，创建并可选写入新身份的长期指令 |

### 远端模型切换

远端每台机器的模型行就是「本地能选的模型」。在设置中点击「添加模型」，选择身份和远端模型后保存，即可在对话输入框选择这一行。候选模型来自 Hermes 的 `provider_models_cache.json`；也可以展开「批量添加远端模型」，点模型芯片一次添加多行。于是：

- 在 dsh 的模型选择器里换一行 = 换远端这一轮跑的模型，**不用改远端配置、不用重启 dsh**；
- 「远端模型」选「身份默认模型」的那一行 = 用该身份自己的默认模型；
- 只改模型行时保存**立即生效**：保存后插件会用 `registration.replace()` 重新提交同一批路由，从而发布 `llm/adapters-updated`——浏览器端的模型目录只在这个事件（或设置/凭据变更）时重建，不发这个事件的话选择器会一直显示启动时的那份旧列表。只有增删主机才需要重启。

一个 Hermes 的限制：`--resume` 与 `-m` 不能同时用（远端会报 `Resume retains gateway session policy`）。所以**中途换模型**时，插件会放弃 `--resume`、用新模型开一个全新的远端会话，并把 dsh 这边的完整对话作为提示词发过去——上下文不丢，但远端 Hermes 自己的会话记忆会重新开始。真机验证过：

```
[turn 1 · model=hermes]  R1      stored={session: local-8976…, model: ""}
[turn 2 · model=glm-5.3] ORCHID   stored={session: local-7282…, model: "glm-5.3"}
MODEL SWITCH OK
```

## 会话状态与持久化

`~/.dsh/oh-my-hermes/<provider>.json`：

```json
{ "hermes-remote:session-8f2c…": { "session": "local-09f58e02f8…", "model": "", "scope": "目标及启动参数的 SHA-256 指纹" } }
```

键是 `provider:dsh 会话 id`，值是远端会话 id 以及**它启动时用的模型**——模型变了就不 resume（见上）。删掉这个文件只会让下一轮变成"全新远端会话"，不会丢 dsh 这边的历史。

`scope` 将续接关系绑定到 SSH 目标、命令、工作目录、profile 和启动参数；目标变化时携带文本历史重建会话。1.6.0 升级前的指纹未固定身份，会重建一次。每轮开始时先移除旧映射，仅在完成帧与 SSH 退出都成功后提交新映射；失败、中断和提前关闭流都会在下一轮重建。`persistSessions: false` 时映射只在内存中保留，进程重启后重建。

工具活动和诊断会隐藏已知本机环境变量密钥，以及常见的远端凭据字段、Bearer 令牌和 URL 密码。脱敏仅用于显示内容，不修改发给 Hermes 的提示词或实际工具操作；任意未标记的秘密字符串仍可能出现在输出中。

## 错误处理

远端失败会映射成带可读原因和错误码的 `finish.error`：

| 情形 | 码 |
|---|---|
| `Permission denied (publickey)` | `SSH_AUTH` |
| `Host key verification failed` | `SSH_HOST_KEY` |
| `Could not resolve hostname` | `SSH_DNS` |
| 连不上 22 端口 | `SSH_UNREACHABLE` |
| 远端找不到 `hermes` | `HERMES_NOT_FOUND` |
| 远端不认识这个模型 | `HERMES_MODEL` |
| 远端 401 / 没有 API key | `HERMES_AUTH` |
| 远端限流/额度 | `HERMES_QUOTA` |
| 超时 | `TIMEOUT` |
| SSH 正常退出但缺少完成帧 | `HERMES_PROTOCOL` |
| 当前选择的模型行已被移除 | `MODEL_NOT_CONFIGURED`（不会自动落到其它身份） |
| 其它 | `PROVIDER_ERROR` |

## 开发与测试

```powershell
node --test tests/*.test.mjs           # 流式、配置、并发续接、取消、SSH、HTTP 权限与客户端注册
node tools/inspect-catalog.mjs         # 打印真实配置文件里最终会进模型选择器的模型行
node tools/smoke-remote.mjs            # 真机两轮，验证 --resume
node tools/smoke-switch.mjs            # 真机换模型，验证上下文随之迁移
node tools/smoke-tools.mjs             # 真机跑一条 shell，验证工具行与 token 计数
node tools/smoke-profiles.mjs          # 真机创建临时身份、写指令、两轮续接，并清理测试身份
```

冒烟脚本要 spawn ssh 并用管道，**不能在 dsh 的工具沙箱里跑**（`spawn EPERM`），在普通终端里跑。

可选浏览器回归：`node tools/verify-ui.mjs`。需要 Playwright（可用 `HERMES_PLAYWRIGHT_PATH` 指定模块位置）、marked（`HERMES_MARKED_PATH`），以及 `.preview/react.js`、`.preview/react-dom.js` 两份 React 18 UMD 文件；自定义浏览器可用 `HERMES_CHROMIUM_PATH` 指定可执行文件。脚本使用临时配置和假的 SSH 子进程，验证保存、连接、技能、工具 Markdown 折叠/键盘/历史重挂载/正文隔离、错误恢复及桌面、手机、深色截图，不连接真实远端。工具展示测试使用 marked 生成 Markdown DOM，匹配本机宿主的代码块结构；不等同于操作实际 DSH 窗口。

## 适用范围与限制

- **只搬文本**：图片、文件附件不会转发给远端；远端也看不到本地文件。
- 远端的工具调用只以文本呈现，不是 dsh 的工具卡片，也无法在 dsh 里批准/拒绝。
- 每轮一次 SSH + 一次进程启动（约 2–5 秒固定开销）；Hermes 没有长连接模式可用。
- 远端会话 id 只按 dsh 会话存；在 dsh 里"新建会话"会开一个全新的远端会话。
- 不能替代本地 agent：远端用什么工具、什么模型、什么额度，全由那台机器决定。

## 许可证与参考项目

参考项目及其许可见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。

MIT

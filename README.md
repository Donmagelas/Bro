# bro

面向 macOS 和 Windows 的个人 Agent 工作台：一个 bro，多个会话。桌面布局参考 Codex；飞书、Peer 和本机事件通过独立后台进入会话队列。

目前是 **0.1 开发版**。macOS Apple Silicon 的应用包、GUI 配置、真实 OMP 工具执行、跨会话交办和关窗后的后台运行已验证。真实模型账号、飞书收发、原生桌面权限、Mnemopi 和 Windows 尚有验收缺口，详见 [实施进度](docs/changes/agent-workbench/implementation.md) 和 [待处理事项](docs/changes/agent-workbench/open-issues.md)。

## 运行

源码开发需要 Bun 1.4.2，建议另装 Git。项目自带固定版本 OMP 18.4.3 和 Electron 44.4.5。

```sh
bun install --frozen-lockfile
bun run dev
```

生产界面：

```sh
bun run build
bun run start
```

进入「设置与连接 → 模型」，选择 ChatGPT 登录，或填写 API Key、Base URL、模型 ID 与协议。运行中的会话可排队、steer、停止。普通聊天默认使用 bro 自己的数据目录，不会默认读取已有 pi/OMP/Codex 的会话和账号配置。

macOS 后台启动时会继承系统手动 HTTP/HTTPS 代理；显式设置的代理环境变量优先，本机回调和 GUI 连接保持直连。修改系统代理后需在通用设置里“停止后台并退出”，再打开 bro。PAC/WPAD 和 Windows 系统代理自动继承尚未接入；可使用标准代理环境变量。浏览器完成授权不等于后台令牌交换成功，登录地区 403 会单独提示。

若下载 Electron 失败，可执行 `node node_modules/electron/install.js`；网络环境需要时可自行设置 `ELECTRON_MIRROR`。开发启动时 Bun 应在 PATH 中，也可通过 `BRO_BUN_PATH` 指定它的完整路径。

## 当前能力

- 项目、会话、重命名、置顶、归档、删除、历史恢复与分支；Markdown、图片、工具输出、文件链接、基础 Git diff 和文字批注。
- 独立 OMP 进程、持久队列、跨会话查询和异步交办。非 GUI 消息全部排队。同一工作目录的普通任务按轮次串行，不同目录可并行。
- GUI 关闭后，宿主和运行中的任务继续；可选择登录电脑后启动后台，也可在设置中明确停止后台并退出。
- 飞书官方长连接、可信 open_id 名单、私聊及群成员 @ 路由、引用与附件处理、分段回复及待核对投递记录。须配置自己的飞书应用和权限。
- Peer Relay `/sub`、`/send` 协议，含补投、去重、可信来源和关联回复；通用 SSE、进程 stdout 和文件变化监听。无事件时不调用模型。
- 从本地/Git 安装 Skill 和 OMP 插件，配置 MCP；启停和更新在安全的运行边界生效。项目规则只加载当前项目的 `AGENTS.md` 和 bro 明确配置的资源。
- OMP 原有无头浏览器、文件编辑、终端、搜索、临时子任务和开发工具。原生桌面通过 OMP native 后端操作，配有批次协调和系统输入监听；首次使用必须具备系统权限。
- Mnemopi 默认关闭，可手动开启并持久保存选择；Skill 选择、上下文选择、压缩重点的常规/旁路/实验三种策略。Jev 和 Laya 复用 OMP 的 System One 协议客户端，失败回退常规。常规模式不请求判断模型。

GUI 显示模型返回的 token 用量和 OMP 上下文估算。自定义 API 没有配置价格表时显示费用未知，不把 0 当成真实费用。ChatGPT 订阅额度以服务端为准。模型连接支持编辑、删除和设为默认；会话草稿独立保存，归档会话可查看和恢复。

## 配置与数据

默认数据位置：

- macOS：`~/Library/Application Support/bro`
- Windows：`%LOCALAPPDATA%/bro`
- 测试或独立实例：设置 `BRO_DATA_DIR`

宿主管理 `host.sqlite` 中的队列、绑定和投递关联；OMP 管理 `sessions/` 中的权威聊天历史。凭据存放在此私有数据根目录内，不应提交到 Git。设置中可打开数据目录查看 `logs/`。

飞书需要启用 Bot、长连接事件 `im.message.receive_v1` 和消息/附件权限；首先把自己的 `ou_…` 加入可信名单。群里只有实际 @ Bot 的可信成员才触发任务，同一群的不同成员有独立会话。会话归档/删除解除绑定，下次有效消息重新创建。

Peer 的身份、Token、可信发送者和目标会话必须显式配置；不会自动启用已有 Peer 账号。Jev/Laya 设置填写服务根地址，客户端追加 `/v1/systemone`。Laya 可使用 `multilingual` 模型；本项目不自动安装其模型权重。

## 构建与验证

```sh
bun run check
bun test tests
bun run probe:omp
bun run probe:runtime
bun run probe:controls
bun run probe:memory
bun run probe:desktop
bun run package
```

探针使用本机确定性模型接口，运行的是实际 OMP 进程和工具；它们不验证真实账号授权或模型质量。`probe:runtime` 可通过 `BRO_PROBE_BROWSER` 指定 Chrome/Chromium 可执行文件，额外验证独立无头浏览器。`probe:memory` 验证原生 Mnemopi 的自动保存和 FTS 检索/注入、on/off。首版使用文本检索，默认向量模型与语义检索暂缓；smol 抽取模型仍需验收。

在 macOS 打包会生成 `out/macos-arm64/bro.app` 与 ZIP，包含 Bun、生产依赖和预编译输入监听器，使用本地 ad-hoc 签名。Windows 原生打包脚本生成 `out/windows-x64/bro/bro.exe` 和 ZIP；当前未在 Windows 实机完成验收。构建流程见 `.github/workflows/check.yml`。可通过 `BRO_NPM_REGISTRY` 为打包时的依赖安装指定镜像。

macOS 需要辅助功能/输入监控权限才能启用原生桌面操作；当前能力探针与待补验收记录在实施文档中。应用包尚未进行 Apple 公证或正式 Windows 代码签名。

## 范围与资料

不实现 Plan/Goal；Appshots、微信、执行沙箱、定时任务、复杂文件预览、高级 diff、临时侧聊，以及此前明确暂缓的 OMP 附加功能不纳入此版。官方托管连接器和云端执行不在范围内。Mac 锁屏后的桌面操作为可选探索。

- [确认的需求与取舍](docs/changes/agent-workbench/solution.md)
- [实施步骤、进度与证据](docs/changes/agent-workbench/implementation.md)
- [需要后续处理的事项](docs/changes/agent-workbench/open-issues.md)

本轮实现保存在 `codex/initial-desktop` 工作分支；遵循本轮提供的协作约束，不创建或合并 PR，也不将功能变更直接合入 main。

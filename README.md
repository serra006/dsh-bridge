# DSH Bridge

让 **DeepSeek Harness** 用上 **OpenCode 免费模型** 的托盘应用：本地跑一个隔离的 OpenCode 做代理，自动发现免费模型，**一键导入**到 DeepSeek Harness 的模型配置。

思路借鉴 [ow-bridge](https://github.com/louchi1984-coder/ow-bridge)（WorkBuddy → OpenCode 免费模型），代码为本项目重新实现。

## 工作原理

1. 应用首次启动时自动准备 OpenCode（优先用你机器上已装的，没有就从 npm 下载到应用数据目录，官方源失败回退 npmmirror 镜像）；
2. 用隔离配置（`OPENCODE_CONFIG`）在 `127.0.0.1` 启动 `opencode serve`，不碰你自己的 opencode 配置；
3. 从 serve 的 `/config/providers` 拉取模型列表，按 `cost: 0` 识别免费模型，逐个发探测消息验证可用性（免费名单经常变，不硬编码）；
4. 在 `127.0.0.1:5180` 提供 **OpenAI 兼容** 的代理服务（`/v1/models`、`/v1/chat/completions`，支持流式）。每个请求走一次性 opencode 会话，工具调用固定禁用，纯文本对话；
5. 点击「一键导入」，把可用模型写进 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers["dsh-bridge"]`，DeepSeek Harness 里就能直接选了。

## 下载

| 系统 | 状态 | 下载 |
| --- | --- | --- |
| Windows x64 | 免安装 portable | Releases 页下载 `DSH-Bridge-<版本>-win-x64-portable.zip` |

> 未做代码签名，Windows 首次运行可能提示"未知发布者"，属正常现象（与 ow-bridge 一致）。

## 使用

1. 完整解压 zip，双击 `DSH Bridge.exe`（不要只复制 exe，要保留旁边的 `resources` 等文件）；
2. 首次启动会自动下载 OpenCode、扫描免费模型（需要联网，耗时 1-3 分钟），托盘图标会显示进度；
3. 打开控制面板，确认模型列表，点击「**一键导入到 DeepSeek Harness**」；
4. 把环境变量 `DSH_BRIDGE_API_KEY` 设为任意值（例如 `local`），再启动 DeepSeek Harness；
5. 在 dsh 的模型下拉框里选择 `DSHB · xxx` 即可使用。

- 关闭窗口只会隐藏到托盘，继续在后台运行；从托盘「退出」时默认**清理本应用导入的模型条目**，你手动加的配置原样保留（可在托盘菜单关闭该行为）；
- 托盘菜单可随时「重新扫描模型」或「重新导入」；
- 导入前 dsh 的配置文件会被自动备份（`settings.yaml.bak.<时间>`）。

## 开发与打包

```bash
npm install
npm test
npm start            # 开发运行（需装 Electron）
npm run dist:win     # 打 Windows x64 portable 包（在 Linux 下也可执行）
```

## 行为和限制（必读）

- **免费模型及额度由上游（OpenCode Zen）决定**，名单和可用性会变；应用每次启动都会重新探测，不可用模型不会被导入；
- 免费模型有频率限制，请求失败时 dsh 侧会报错，重试或换模型即可；
- v1 只做**纯文本对话**：多轮历史会拼成单条 prompt；图片等多模态暂不支持；
- 代理只监听 `127.0.0.1`，不暴露到局域网；不校验 API key（`DSH_BRIDGE_API_KEY` 填任意值）；
- `temperature`、`max_tokens` 等参数暂不透传；
- 本应用调用 opencode 时禁用了工具执行，模型不会在你机器上跑任何命令。

## 常见问题

- **启动失败 / 卡在"正在启动"**：v0.1.1 起等待时间放宽到 120 秒（Windows 首次启动可能被 Defender 扫描拖慢），状态行会显示进度；如果进程崩溃会直接报真实原因。托盘菜单「打开日志目录」可查看 `opencode-serve.log` 定位问题；
- **网络连不上 registry 或 Zen 网关**：应用优先直连 `registry.npmjs.org` 下载 OpenCode（失败自动换 npmmirror 镜像），最后兜底走 npm；都不行时请检查网络/代理；
- **导入后 dsh 里看不到模型**：确认 `DSH_BRIDGE_API_KEY` 环境变量已设置且 dsh 是在设置后启动的；检查 `~/.dsh/settings.yaml` 里有没有 `dsh-bridge` 这一节；
- **Windows 提示 SmartScreen**：未签名应用的正常提示，确认文件来自本仓库 Releases 后选择"仍要运行"。

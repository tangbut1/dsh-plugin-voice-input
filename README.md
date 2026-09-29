# dsh-plugin-voice-input

DeepSeek Harness 官方桌面版（Desktop）与 Web 语音输入插件：在输入框发送键同一行、靠发送键左侧加一个「按住说话」麦克风按钮。松手后语音在**本机离线**转成文字并追加到当前草稿，**不自动发送**。模型免费、离线，中文/英文/中英夹杂（以及日/韩/粤）均可精准识别。

> Voice input plugin for DeepSeek Harness (both Official Desktop and Web UI): hold the mic button next to the send key to talk; on release the audio is transcribed by a local offline ASR engine and appended to the draft. Free, offline, zh/en mixed supported.

## 核心特性与适配

- **全平台双端支持**：完美兼容 DeepSeek Harness **官方桌面版（Electron 客户端）** 与 **Web 网页版**。
- **桌面端协议与安全适配**：深度适配官方桌面版的 `dsh-app://` 特权协议及 Chromium 私有网络访问安全规范（Private Network Access, PNA），支持即时分层加载。
- **离线安全私密**：ASR 识别服务只监听本机 `127.0.0.1:18765`，音频数据全程在本地处理，绝不上传云端，模型与原生扩展全部本地离线运行。
- **无感输入追加**：识别结果通过当前会话上下文与官方事件注入当前输入框末尾，支持实时草稿读取与 `draftRev` CAS 安全校验，绝不触碰非公开 DOM，不破坏撤销树，不自动提交。

## 架构

双端插件（一个包，两个半边）：

| 半边 | 位置 | 职责 |
|---|---|---|
| 主机 half | `src/index.ts` → `lib/index.js` | 极简 HTTP 服务，**只监听 127.0.0.1:18765**；sherpa-onnx + SenseVoice-Small INT8 离线识别；放行 `dsh-app://` 来源并支持 PNA 预检；模型缺失时自动下载 |
| 客户端 half | `src/client/index.ts` → `lib/client.js` | 麦克风按钮（官方 slot `conversation.input.right`）；MediaRecorder 16 kHz 单声道录音；WAV 编码后 POST 到本机 ASR；实时获取当前会话草稿并通过官方事件/输入机追加进输入框 |

- 按钮挂在官方 slot `conversation.input.right`（发送键左侧同一行），不替换 composer、不动发送键。
- 识别结果优先通过官方 scoped 事件 `slash/input-insert-text`（payload `{ text, span }`）追加到草稿末尾；若草稿非空前面自动补一个空格；针对不同版本的宿主环境提供多重草稿上下文提取与注入兜底。
- ASR 引擎：`sherpa-onnx-node`（npm 包，含 Windows x64 预编译二进制）+ 模型 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（INT8，`model.int8.onnx` ≈ 228 MB，压缩包 ≈ 229 MB）。

## 安装与使用

### 场景一：DeepSeek Harness 官方桌面版（Electron 客户端）

#### 1. 命令行添加（推荐）

通过桌面版自带的 `dsh` CLI 将本插件添加至 `desktop` profile：

```powershell
# 语法：<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add <本插件目录或git仓库>
& "F:\agent\DeepSeek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add D:\path\to\dsh-plugin-voice-input
```

或者使用 GitHub 仓库链接安装：
```powershell
& "F:\agent\DeepSeek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:tangbut1/dsh-plugin-voice-input
```

#### 2. 生效方式
- 启动或重启 DeepSeek Harness 官方桌面端，进入主会话页面。
- 输入框发送键左侧即可看到麦克风按钮。按住麦克风即可开始录音说话，松手即自动识别转文字。

---

### 场景二：DeepSeek Harness Web 网页版

```powershell
# 添加到 web profile
dsh plugin --profile web add D:\path\to\dsh-plugin-voice-input

# 重启 dsh web 服务
dsh web --port 3080
```

浏览器打开网页端即可看到麦克风按钮。

---

### 卸载插件

- **桌面版卸载**：
  ```powershell
  & "<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-plugin-voice-input
  ```
- **Web 版卸载**：
  ```powershell
  dsh plugin --profile web remove dsh-plugin-voice-input
  ```

## 本地开发与构建

```powershell
cd dsh-plugin-voice-input
npm install     # 安装依赖与原生扩展
npm run build   # esbuild 构建 lib/index.js 与 lib/client.js
npm run typecheck # TypeScript 类型检查
```

## 模型下载

首次识别（POST `/asr`）时会自动下载 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`（约 **229 MB**）到插件数据目录，并用系统自带 `tar`（Windows 10+ 自带）解压。`GET /health` 可看状态与下载进度。

数据目录（默认）：`$DSH_HOME/plugins/dsh-plugin-voice-input`，未设置 `DSH_HOME` 时是 `~\.dsh\plugins\dsh-plugin-voice-input`。

也可以手动下载放置：

```powershell
$dir = if ($env:DSH_HOME) { "$env:DSH_HOME\plugins\dsh-plugin-voice-input" } else { "$HOME\.dsh\plugins\dsh-plugin-voice-input" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" -OutFile "$dir\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
tar -xjf "$dir\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" -C $dir
```

## 端口与环境变量

| 项 | 说明 |
|---|---|
| ASR 服务地址 | `http://127.0.0.1:18765`（只监听本地回环，禁止外部非授权请求） |
| `DSH_VOICE_ASR_PORT` | 自定义覆盖 ASR 端口（默认 18765） |
| `DSH_VOICE_DATA_DIR` | 自定义覆盖模型保存目录 |
| CORS / 来源许可 | 支持 `dsh-app://app`（官方桌面端）、`localhost`、`127.0.0.1`、内网 IP 地址，提供 PNA 响应头 |

## 验证与体验

1. 打开桌面版客户端或 Web 界面，发送按钮左侧能看到麦克风按钮。
2. 按住按钮说话（中文、英文、中英混杂均可），松开手。
3. 界面显示「识别中…」，片刻后转写文字自动追加进输入框中，不会自动发送。
4. 本地请求 `Invoke-RestMethod http://127.0.0.1:18765/health` 可直接查看引擎健康状态。

## 参与共建

MIT 协议开源，欢迎提 Issue 与 PR 共同维护。

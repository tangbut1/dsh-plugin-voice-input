# dsh-plugin-voice-input

DeepSeek Harness Web 语音输入插件：在输入框发送键同一行、靠发送键左侧加一个「按住说话」麦克风按钮。松手后语音在**本机离线**转成文字并追加到当前草稿，**不自动发送**。模型免费、离线，中文/英文/中英夹杂（以及日/韩/粤）均可识别。

> Voice input plugin for the DeepSeek Harness Web UI: hold the mic button next to the send key to talk; on release the audio is transcribed by a local offline ASR engine and appended to the draft. It never auto-sends. Free, offline, zh/en mixed supported.

## 架构

双端插件（一个包，两个半边）：

| 半边 | 位置 | 职责 |
|---|---|---|
| 主机 half | `src/index.ts` → `lib/index.js` | 极简 HTTP 服务，**只监听 127.0.0.1:18765**；sherpa-onnx + SenseVoice-Small INT8 离线识别；模型缺失时自动下载 |
| 浏览器 half | `src/client/index.ts` → `lib/client.js` | 麦克风按钮（官方 slot `conversation.input.right`）；MediaRecorder 16 kHz 单声道录音；WAV 编码后 POST 到本机 ASR；用官方事件把文本追加进草稿 |

- 按钮挂在官方 slot `conversation.input.right`（发送键左侧同一行），不替换 composer、不动发送键。
- 识别结果通过官方 scoped 事件 `slash/input-insert-text`（payload `{ text, span }`，span 带 `draftRev` CAS）追加到草稿末尾；草稿非空时前面补一个空格。
- 不调用未公开的 setDraft、不改 textarea DOM、不自动发送。
- ASR 引擎：`sherpa-onnx-node`（npm 包，含 Windows x64 预编译二进制）+ 模型 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（INT8，`model.int8.onnx` ≈ 228 MB，压缩包 ≈ 229 MB）。
- 不用 Web Speech API（会上传音频且国内不稳定）；音频只发到本机回环地址。

## 安装与构建

```powershell
cd D:\dsh\dsh-plugin-voice-input
npm install     # 安装 sherpa-onnx-node 原生扩展 + 构建工具（一次性）
npm run build   # 产出 lib/index.js（主机半边）和 lib/client.js（浏览器半边）
npm run typecheck   # 可选
```

## 启动方式

### 方式 A：--patch（只验证主机半边 ASR 服务）

浏览器半边需要行名是可解析的**包名**（client-modules 会读 `<name>/package.json`），`--patch` 里放文件路径只能加载主机半边：

```powershell
dsh web --patch D:\dsh\dsh-plugin-voice-input\cordis.dev.yml
# 验证服务：
Invoke-RestMethod http://127.0.0.1:18765/health
```

### 方式 B：dsh plugin add（完整 UI，推荐）

```powershell
dsh plugin --profile web add D:\dsh\dsh-plugin-voice-input
# 重启 dsh web（插件集在启动时读取）
dsh web --port 3080
```

打开 `http://127.0.0.1:3080`，发送键旁应出现麦克风按钮。卸载：

```powershell
dsh plugin --profile web remove dsh-plugin-voice-input
```

> 注意：`dsh plugin add` 会修改 `$DSH_HOME/profiles/web` 的 profile 清单；正在运行的实例需要重启后才生效。

### 方式 C：从 GitHub 安装（社区用户）

```powershell
dsh plugin --profile web add github:<owner>/dsh-plugin-voice-input
```

首次安装时 pnpm ≥10 会拒绝执行 git 依赖的 `prepare` 构建脚本，按 dsh 提示把包名加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-plugin-voice-input: true
```

再重跑一次 `add` 即可（`prepare` 会自动构建 `lib/`；模型在首次识别时自动下载）。建议固定到某个提交：`github:<owner>/dsh-plugin-voice-input#<sha>`。

## 模型下载

首次识别（POST `/asr`）时自动下载 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`（约 **229 MB**）到插件数据目录，并用系统自带 `tar`（Windows 10+ 自带）解压。`GET /health` 可看下载进度。

数据目录（默认）：`$DSH_HOME/plugins/dsh-plugin-voice-input`，未设置 `DSH_HOME` 时是 `~\.dsh\plugins\dsh-plugin-voice-input`。

也可以手动下载（放对位置后不会再触发自动下载）：

```powershell
$dir = if ($env:DSH_HOME) { "$env:DSH_HOME\plugins\dsh-plugin-voice-input" } else { "$HOME\.dsh\plugins\dsh-plugin-voice-input" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" -OutFile "$dir\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
tar -xjf "$dir\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2" -C $dir
```

## 端口与环境变量

| 项 | 值 |
|---|---|
| ASR 服务 | `http://127.0.0.1:18765`（**只绑回环**，不监听 0.0.0.0） |
| `DSH_VOICE_ASR_PORT` | 覆盖端口（默认 18765） |
| `DSH_VOICE_DATA_DIR` | 覆盖模型数据目录 |
| CORS | 仅接受 `localhost` / `127.0.0.1` / `::1` / 内网地址来源的页面 |

## 依赖

- 运行时：`sherpa-onnx-node`（^1.13.5，随 `npm install` 自动装好，含预编译二进制，无需 GPU/Electron/Docker）。
- 系统：Windows 10+ 自带 `tar.exe`（模型解压用）。
- 浏览器：Chrome/Edge 最佳（MediaRecorder + decodeAudioData）；Firefox/Safari 自动回退到 ScriptProcessor 原始采样。

## 验证

1. `dsh web` 打开后，发送键左侧能看到麦克风按钮。
2. 按住按钮说一句中英夹杂的话，松手 → 「识别中…」→ 文字出现在输入框且没有自动发出。
3. 用不带本插件的 `dsh web` 启动（或停掉 18765 端口）时按按钮 → 提示「语音服务不可用」。
4. 在浏览器弹窗里拒绝麦克风权限后按按钮 → 提示「麦克风权限被拒绝」。
5. `Invoke-RestMethod http://127.0.0.1:18765/health` 返回 `ok: true`（模型就绪后）。

## 参与共建

MIT 协议开源，欢迎任何人提 Issue / PR 共同维护。本地开发环境：

```powershell
git clone git@github.com:<owner>/dsh-plugin-voice-input.git
cd dsh-plugin-voice-input
npm install        # 依赖（含 sherpa-onnx-node 原生扩展与 esbuild）
npm run build      # 产出 lib/index.js 与 lib/client.js
npm run typecheck  # 类型检查
node scripts/test-host.mjs   # 主机半边独立冒烟（不需要 dsh）
dsh --profile web --patch D:\dsh\dsh-plugin-voice-input\cordis.dev.yml  # 主机半边联调
```

修改后 `npm run build` 再验证。常见贡献方向：VAD/流式识别、录音格式回退、更多语言、错误文案与 i18n。

## 已知限制

- 模型首次使用需下载约 229 MB（自动，一次性）。
- 按住-松开式整段识别，非实时流式；长录音（>30 s）识别耗时变长。
- 未集成 VAD：静音或过短的录音会得到「未识别到语音内容」。
- 插入使用 `draftRev` CAS，若识别期间用户改过草稿且已提交（draft 已清空/更换），插入失败会提示重试；普通打字不影响（按识别完成时的最新草稿追加）。
- 语言自动检测（`auto`），不按会话固定语言。
- 个别浏览器无法解码 MediaRecorder 输出时提示改用 Chrome/Edge（或自动走 ScriptProcessor 回退）。

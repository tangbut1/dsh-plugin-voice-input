/**
 * dsh-plugin-voice-input — host half.
 *
 * Runs a loopback-only HTTP service (default http://127.0.0.1:18765) that
 * transcribes PCM WAV audio with sherpa-onnx + SenseVoice-Small INT8
 * (sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17, ~228 MB model,
 * zh/en/ja/ko/yue incl. mixed, language auto-detected). The model tarball
 * auto-downloads to the plugin data directory on first use and is extracted
 * with the system `tar` (bundled with Windows 10+).
 *
 * Endpoints (loopback only):
 *  - GET  /health -> model state (ready / downloading / missing / error)
 *  - POST /asr    -> WAV body (PCM 8/16-bit, any rate) -> { text }
 *
 * Environment overrides: DSH_VOICE_ASR_PORT (default 18765),
 * DSH_VOICE_DATA_DIR (default $DSH_HOME/plugins/dsh-plugin-voice-input,
 * falling back to ~/.dsh/plugins/dsh-plugin-voice-input).
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODEL_DIR_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_DIR_NAME}.tar.bz2`
const SAMPLE_RATE = 16000
const MAX_BODY_BYTES = 20 * 1024 * 1024

/** Minimal structural face of the Cordis context this plugin uses. */
interface PluginContext {
  effect(fn: () => (() => void) | void, label?: string): void
  logger?: {
    info(value: unknown): void
    warn(value: unknown): void
    error(value: unknown): void
  }
}

interface ModelState {
  state: 'missing' | 'downloading' | 'ready' | 'error'
  percent?: number
  message?: string
}

interface AsrEngine {
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>
}

/** Structural face of the sherpa-onnx-node module (see src/sherpa-onnx-node.d.ts). */
type SherpaModule = typeof import('sherpa-onnx-node')

export const name = 'voice-input'

let modelState: ModelState = { state: 'missing' }
let engine: AsrEngine | null = null
let engineInit: Promise<AsrEngine> | null = null
let downloadAbort: AbortController | null = null

/** Data directory for the model tarball and its extracted tree. */
function dataDir(): string {
  const override = process.env.DSH_VOICE_DATA_DIR
  if (override !== undefined && override !== '') return override
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-plugin-voice-input')
}

/** ASR listen port from env, falling back to the documented default. */
function port(): number {
  const raw = Number(process.env.DSH_VOICE_ASR_PORT)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 18765
}

/** Ensure model.int8.onnx + tokens.txt exist locally, downloading once if needed. */
async function ensureModel(): Promise<{ model: string; tokens: string }> {
  const dir = join(dataDir(), MODEL_DIR_NAME)
  const model = join(dir, 'model.int8.onnx')
  const tokens = join(dir, 'tokens.txt')
  if (existsSync(model) && existsSync(tokens)) {
    modelState = { state: 'ready' }
    return { model, tokens }
  }
  const root = dataDir()
  mkdirSync(root, { recursive: true })
  const archive = join(root, `${MODEL_DIR_NAME}.tar.bz2`)
  modelState = { state: 'downloading', percent: 0 }
  try {
    await download(MODEL_URL, archive)
    await extract(archive, root)
    if (!existsSync(model) || !existsSync(tokens)) {
      throw new Error('模型压缩包解压后缺少 model.int8.onnx 或 tokens.txt')
    }
    modelState = { state: 'ready' }
    return { model, tokens }
  } catch (error) {
    modelState = {
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
    throw error
  }
}

/** Stream the model tarball to disk with progress on the shared model state. */
async function download(url: string, dest: string): Promise<void> {
  downloadAbort = new AbortController()
  const res = await fetch(url, { redirect: 'follow', signal: downloadAbort.signal })
  if (!res.ok || res.body === null) {
    throw new Error(`模型下载失败 (HTTP ${String(res.status)})`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const out = createWriteStream(dest)
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      received += value.byteLength
      await new Promise<void>((resolve, reject) => {
        out.write(Buffer.from(value), (error) => (error === null ? resolve() : reject(error)))
      })
      if (total > 0) {
        modelState = {
          state: 'downloading',
          percent: Math.min(99, Math.floor((received / total) * 100)),
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error: Error | null) => (error === null ? resolve() : reject(error)))
    })
  } catch (error) {
    out.destroy()
    throw error
  } finally {
    downloadAbort = null
  }
}

/** Extract a .tar.bz2 with the system tar (bsdtar on Windows 10+, GNU tar elsewhere). */
async function extract(archive: string, dir: string): Promise<void> {
  modelState = { state: 'downloading', percent: 99 }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar 解压失败 (exit ${String(code)}): ${stderr.slice(0, 200)}`))
    })
  })
}

/** Lazily construct the recognizer; a failed init resets so the next request retries. */
function initEngine(): Promise<AsrEngine> {
  if (engineInit === null) {
    engineInit = (async () => {
      const { model, tokens } = await ensureModel()
      // CJS/ESM interop: the native package exposes its classes on the default
      // export of the dynamic-import namespace (cjs-module-lexer only picks up
      // a subset as named exports).
      const loaded = await import('sherpa-onnx-node') as unknown as SherpaModule | { default: SherpaModule }
      const sherpa: SherpaModule = 'default' in loaded ? loaded.default : loaded
      const config = {
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
          tokens,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      }
      const recognizer = new sherpa.OfflineRecognizer(config)
      const ready: AsrEngine = {
        async transcribe(samples, sampleRate) {
          const stream = recognizer.createStream()
          try {
            stream.acceptWaveform({ samples, sampleRate })
            const result = await recognizer.decodeAsync(stream)
            return typeof result.text === 'string' ? result.text : ''
          } finally {
            // Stream handles are released by the addon finalizers; the JS API exposes no free().
          }
        },
      }
      engine = ready
      return ready
    })().catch((error: unknown) => {
      engineInit = null
      throw error
    })
  }
  return engineInit
}

/** Parse a WAV byte buffer into Float32 samples + the rate it declares. */
function wavToFloat32(body: Buffer): { samples: Float32Array; sampleRate: number } {
  if (body.length < 44) throw new Error('音频数据过短')
  if (body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 音频')
  }
  let offset = 12
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null
  let data: Buffer | null = null
  while (offset + 8 <= body.length) {
    const id = body.toString('ascii', offset, offset + 4)
    const size = body.readUInt32LE(offset + 4)
    const chunk = body.subarray(offset + 8, offset + 8 + size)
    if (id === 'fmt ') {
      format = {
        audioFormat: chunk.readUInt16LE(0),
        channels: chunk.readUInt16LE(2),
        sampleRate: chunk.readUInt32LE(4),
        bits: chunk.readUInt16LE(14),
      }
    } else if (id === 'data') {
      data = chunk
    }
    offset += 8 + size + (size % 2)
  }
  if (format === null || data === null) throw new Error('WAV 缺少 fmt/data 块')
  if (format.audioFormat !== 1) throw new Error('仅支持 PCM WAV')
  if (format.channels < 1) throw new Error('WAV 声道数无效')
  const bytesPerSample = Math.max(1, Math.floor(format.bits / 8))
  const stride = bytesPerSample * format.channels
  const samples = new Float32Array(Math.floor(data.length / stride))
  let n = 0
  for (let i = 0; i + bytesPerSample <= data.length; i += stride) {
    let value = 0
    if (format.bits === 16) value = data.readInt16LE(i)
    else if (format.bits === 8) value = (data[i] - 128) << 8
    samples[n++] = value / 32768
  }
  return { samples: samples.subarray(0, n), sampleRate: format.sampleRate }
}

/** Accept requests only from localhost / loopback / private-network page origins or DSH desktop scheme. */
function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '' || origin === 'null') return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  // DeepSeek Harness Desktop (Electron) origin: dsh-app://app or dsh-app://shell
  if (url.protocol === 'dsh-app:' && (url.hostname === 'app' || url.hostname === 'shell')) {
    return true
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isLoopbackOrPrivate(host)
}

/** Loopback plus RFC1918 / link-local IPv4 and ULA/link-local IPv6 prefixes. */
function isLoopbackOrPrivate(host: string): boolean {
  if (host === '::1' || host === '127.0.0.1') return true
  const v4 = host.split('.').map(Number)
  if (v4.length === 4 && v4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4
    return (
      a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
    )
  }
  if (host.includes(':')) {
    const lower = host.toLowerCase()
    return (
      lower.startsWith('fc')
      || lower.startsWith('fd')
      || lower.startsWith('fe8')
      || lower.startsWith('fe9')
      || lower.startsWith('fea')
      || lower.startsWith('feb')
    )
  }
  return false
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-allow-private-network': 'true',
    vary: 'Origin',
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  cors?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    ...(cors ?? {}),
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        reject(new Error('audio too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** True when both model files are already on disk (the engine can load without downloading). */
function modelFilesPresent(): boolean {
  const dir = join(dataDir(), MODEL_DIR_NAME)
  return existsSync(join(dir, 'model.int8.onnx')) && existsSync(join(dir, 'tokens.txt'))
}

function health(): unknown {
  const files = modelFilesPresent()
  return {
    // Usable when the engine is warm, or when the model sits on disk and will be
    // loaded on demand — the recognizer is built lazily inside the first /asr
    // request, so a fresh process is 'missing' yet perfectly serviceable.
    ok: modelState.state === 'ready' || (modelState.state === 'missing' && files),
    engine: 'sherpa-onnx sense-voice-small int8',
    model: MODEL_DIR_NAME,
    port: port(),
    modelFiles: files,
    modelState,
  }
}

async function handleAsr(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
  if (modelState.state === 'downloading') {
    writeJson(res, 202, {
      error: `模型下载中 ${String(modelState.percent ?? 0)}%，请稍候再试`,
      code: 'downloading',
      percent: modelState.percent ?? 0,
    }, cors)
    return
  }
  let body: Buffer
  try {
    body = await readBody(req, MAX_BODY_BYTES)
  } catch {
    writeJson(res, 413, { error: '音频过大', code: 'too-large' }, cors)
    return
  }
  let samples: Float32Array
  let sampleRate: number
  try {
    ({ samples, sampleRate } = wavToFloat32(body))
  } catch (error) {
    writeJson(res, 400, {
      error: `音频解析失败：${error instanceof Error ? error.message : String(error)}`,
      code: 'bad-wav',
    }, cors)
    return
  }
  if (samples.length === 0) {
    writeJson(res, 400, { error: '音频为空（请按住说话）', code: 'empty-audio' }, cors)
    return
  }
  try {
    const ready = engine ?? await initEngine()
    const text = (await ready.transcribe(samples, sampleRate)).trim()
    writeJson(res, 200, { text }, cors)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (modelState.state === 'error') {
      writeJson(res, 502, { error: `识别引擎错误：${modelState.message ?? message}`, code: 'engine' }, cors)
    } else {
      writeJson(res, 500, { error: `识别失败：${message}`, code: 'engine' }, cors)
    }
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin
  if (!allowedOrigin(origin)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '拒绝来自该来源的请求（本服务仅接受本机/内网页面调用）' }))
    return
  }
  const cors = corsHeaders(origin)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    writeJson(res, 200, health(), cors)
    return
  }
  if (req.method === 'POST' && path === '/asr') {
    await handleAsr(req, res, cors)
    return
  }
  writeJson(res, 404, { error: 'not found' }, cors)
}

/**
 * Host plugin body: start the loopback ASR service, owned by the plugin
 * fiber so stop/update removes the listener and aborts any in-flight
 * download.
 * @param ctx - plugin context.
 */
export function apply(ctx: PluginContext): void {
  const host = '127.0.0.1'
  const listenPort = port()
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error(`[voice-input] request failed: ${message}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    })
  })
  server.on('error', (error: Error) => {
    ctx.logger?.warn(`[voice-input] ASR service error: ${error.message}`)
  })
  server.listen(listenPort, host, () => {
    ctx.logger?.info(`[voice-input] ASR service listening on http://${host}:${String(listenPort)} (model: ${MODEL_DIR_NAME})`)
  })
  ctx.effect(() => () => {
    downloadAbort?.abort()
    server.closeAllConnections?.()
    server.close()
  }, 'voice-input: asr server')
}

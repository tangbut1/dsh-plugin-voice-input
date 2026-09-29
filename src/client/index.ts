/**
 * dsh-plugin-voice-input — browser half.
 *
 * Registers a hold-to-talk microphone button into the `conversation.input.right`
 * slot (the right end of the composer tool row, immediately before the send
 * button). Audio is recorded with MediaRecorder from a 16 kHz mono AudioContext
 * graph, converted to PCM WAV on the client, POSTed to the loopback ASR
 * service (http://127.0.0.1:18765), and the recognized text is appended to the
 * current draft through the official scoped `slash/input-insert-text` event
 * (payload { text, span }, span CAS'd on draftRev). The draft is never
 * auto-sent, and the textarea DOM is never touched.
 *
 * Fallbacks: browsers without MediaRecorder or WebM decode use a
 * ScriptProcessor raw capture; both produce the same 16 kHz Float32 pipeline.
 */
import React from 'react'
import { useEffect, useRef, useState } from 'react'

const ASR_BASE = 'http://127.0.0.1:18765'
const MIN_RECORD_MS = 300
const ASR_TIMEOUT_MS = 60000
/** Re-probe cadence: fast while the service is missing, slow once it answers. */
const SERVICE_RETRY_MS = 3000
const SERVICE_RECHECK_MS = 30000

/** Official scoped insert-text payload ({@link https://github.com/deepseek-ai/deepseek-harness} ui-input-trigger contract). */
interface TokenSpan {
  start: number
  end: number
  draftRev: number
}

/** The InputState fields this plugin reads off the conversation.input.right owner share (InputZone). */
interface DraftSnapshot {
  draft: string
  draftRev: number
}

/** The session-scoped context face needed to emit the scoped insert event. */
interface ScopedContext {
  bail(carrier: ScopedContext, event: string, payload: unknown): unknown
}

interface SessionsService {
  scope(id: string): ScopedContext | undefined
}

interface SessionInputFace {
  state: { getSnapshot(): DraftSnapshot }
}

interface InputResolver {
  for(actx: ScopedContext): SessionInputFace
}

interface ConversationService {
  input?: InputResolver
}

/** Minimal structural face of the client plugin context this plugin uses. */
interface ClientPluginContext {
  get(name: string): unknown
  slots: {
    inject(name: string, install: () => void): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  sessions: SessionsService
  effect(fn: () => (() => void) | void, label?: string): void
}

/** Inject face delivered to the registered component (per session). */
interface VoiceInject {
  insert(text: string, fallback?: DraftSnapshot): boolean
}

/** Props the component actually reads: owner share + session standard kit + inject face. */
interface VoiceButtonProps extends VoiceInject {
  sessionId?: string
  input?: DraftSnapshot
}

/** A live recording session: stop() resolves the captured 16 kHz mono samples. */
interface RecordSession {
  stop(): Promise<Float32Array | null>
  cancel(): void
}

type Phase = 'idle' | 'recording' | 'recognizing'
type ServiceState = 'unknown' | 'ok' | 'down'

interface ErrorNotice {
  message: string
  seq: number
}

const VOICE_CSS = [
  '@keyframes dshv-pulse {',
  '  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }',
  '  70% { box-shadow: 0 0 0 7px rgba(239, 68, 68, 0); }',
  '  100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }',
  '}',
  '@keyframes dshv-spin { to { transform: rotate(360deg); } }',
  '.dshv-rec { animation: dshv-pulse 1.1s ease-out infinite; }',
  '.dshv-spin { animation: dshv-spin 0.9s linear infinite; }',
].join('\n')

export const inject = ['slots', 'sessions']

/**
 * Client plugin body: register the voice button into the conversation-declared
 * input.right slot. The insert verb resolves the session scope through the
 * sessions service and emits the official scoped event (the same route the
 * slash pipeline uses).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientPluginContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-plugin-voice-input'
    tag.textContent = VOICE_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'voice-input: styles')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'voice-input',
    order: 100,
    label: '语音输入 / Voice input',
    inject: (sessionId: string): VoiceInject & { sessionId: string } => ({
      sessionId,
      insert: (text, fallback) => insertText(ctx, sessionId, text, fallback),
    }),
  }, VoiceButton))
}

/** Read the live draft state through the conversation input resolver (fails soft). */
function liveDraft(ctx: ClientPluginContext, actx: ScopedContext): DraftSnapshot | undefined {
  const conversation = (ctx.get('conversation') ?? (actx as unknown as { get?(name: string): unknown }).get?.('conversation')) as ConversationService | undefined
  const resolver = conversation?.input
  if (resolver === undefined) return undefined
  try {
    const shell = resolver.for(actx) as unknown as {
      state?: { getSnapshot(): DraftSnapshot }
      snapshot?: DraftSnapshot
    }
    const state = shell?.state?.getSnapshot() ?? shell?.snapshot
    if (state !== undefined && typeof state.draft === 'string') {
      return { draft: state.draft, draftRev: state.draftRev ?? 0 }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Append text to the session draft through the official scoped event.
 * The span CAS (draftRev) is computed from the live state at call time;
 * a non-empty draft gets a leading space separator.
 * @returns true only when the owning input machine applied the mutation.
 */
function insertText(
  ctx: ClientPluginContext,
  sessionId: string,
  text: string,
  fallback?: DraftSnapshot,
): boolean {
  const actx = ctx.sessions?.scope(sessionId)
  if (actx === undefined) return false
  const live = liveDraft(ctx, actx) ?? fallback ?? { draft: '', draftRev: 0 }
  const separator = live.draft !== '' && !/[\s\n]$/.test(live.draft) ? ' ' : ''
  const span: TokenSpan = {
    start: live.draft.length,
    end: live.draft.length,
    draftRev: live.draftRev,
  }
  const toInsert = separator + text

  // 1. Official scoped event path
  if (actx.bail(actx, 'slash/input-insert-text', { text: toInsert, span }) === true) {
    return true
  }

  // 2. Direct session input shell fallback
  try {
    const conversation = (ctx.get('conversation') ?? (actx as unknown as { get?(name: string): unknown }).get?.('conversation')) as ConversationService | undefined
    const shell = conversation?.input?.for(actx) as unknown as {
      actions?: { insertText?(text: string, span: TokenSpan): boolean }
      insertText?(text: string, span: TokenSpan): boolean
    }
    if (shell?.actions?.insertText?.(toInsert, span) === true) return true
    if (shell?.insertText?.(toInsert, span) === true) return true
  } catch {
    // ignore
  }

  return false
}

/** Pick a MediaRecorder mime type this browser supports. */
function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type
    } catch {
      // isTypeSupported throwing is a browser quirk; fall through to the default type.
    }
  }
  return undefined
}

/** Open the mic and return a recording session (MediaRecorder primary, ScriptProcessor fallback). */
async function openMic(): Promise<RecordSession> {
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error('当前浏览器不支持麦克风（需要 https 或 localhost）')
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch (error) {
    const err = error as { name?: string }
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      throw new Error('麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问')
    }
    if (err?.name === 'NotFoundError') throw new Error('未找到麦克风设备')
    throw new Error(`无法打开麦克风：${err?.name ?? String(error)}`)
  }

  const Ctor: typeof AudioContext = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (Ctor === undefined) throw new Error('当前浏览器不支持 Web Audio')
  const audioCtx = new Ctor({ sampleRate: 16000 })
  await audioCtx.resume().catch(() => {})
  const source = audioCtx.createMediaStreamSource(stream)
  const dest = audioCtx.createMediaStreamDestination()
  source.connect(dest)
  const contextRate = audioCtx.sampleRate

  const release = async (): Promise<void> => {
    for (const track of stream.getTracks()) track.stop()
    await audioCtx.close().catch(() => {})
  }

  if (window.MediaRecorder !== undefined) {
    const mime = pickMimeType()
    const recorder = new MediaRecorder(dest.stream, mime === undefined ? undefined : { mimeType: mime })
    const chunks: BlobPart[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
    recorder.start()
    return {
      async stop() {
        recorder.stop()
        await stopped
        try {
          const blob = new Blob(chunks, { type: mime ?? recorder.mimeType })
          const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer())
          const samples = decoded.getChannelData(0)
          return resampleTo16000(samples, contextRate)
        } catch {
          throw new Error('浏览器无法解码本次录音，请使用 Chrome/Edge')
        } finally {
          await release()
        }
      },
      async cancel() {
        if (recorder.state !== 'inactive') recorder.stop()
        await release()
      },
    }
  }

  // ScriptProcessor fallback: raw 16 kHz-requested mono capture, no codec round-trip.
  const processor = audioCtx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let total = 0
  processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0)
    const copy = new Float32Array(data)
    chunks.push(copy)
    total += copy.length
  }
  source.connect(processor)
  const mute = audioCtx.createGain()
  mute.gain.value = 0
  processor.connect(mute)
  mute.connect(audioCtx.destination)
  return {
    async stop() {
      processor.disconnect()
      source.disconnect()
      const merged = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      await release()
      return resampleTo16000(merged, contextRate)
    },
    async cancel() {
      processor.disconnect()
      source.disconnect()
      await release()
    },
  }
}

/** Linear-interpolated resample to 16 kHz (no-op when already at 16 kHz). */
function resampleTo16000(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return input
  const ratio = fromRate / 16000
  const length = Math.max(0, Math.floor(input.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] + (input[i1] - input[i0]) * frac
  }
  return out
}

/** Encode 16 kHz mono Float32 samples as 16-bit PCM WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

const MIC_ICON = React.createElement(
  'svg',
  { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'currentColor', 'aria-hidden': true },
  React.createElement('path', {
    d: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z',
  }),
)

const SPINNER = React.createElement(
  'svg',
  { className: 'dshv-spin', viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', 'aria-hidden': true },
  React.createElement('circle', {
    cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 3, strokeDasharray: '42 14',
  }),
)

/**
 * Probe the loopback ASR service; resolves true as soon as it answers at all.
 *
 * The page routinely mounts before the host half has bound its port (the host
 * mounts plugins during boot, the shell can be served earlier), so a single
 * mount-time probe is not enough: this is retried on a timer and again on every
 * press, which lets a stale "unavailable" heal without a page reload.
 */
async function probeService(timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${ASR_BASE}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

/** The hold-to-talk button plus its transient error bubble. */
function VoiceButton(props: VoiceButtonProps): React.ReactElement {
  const { sessionId, input, insert } = props
  const [phase, setPhase] = useState<Phase>('idle')
  const [service, setService] = useState<ServiceState>('unknown')
  const [error, setError] = useState<ErrorNotice | null>(null)
  const sessionRef = useRef<RecordSession | null>(null)
  const startedAtRef = useRef(0)
  // Pointer still held? begin() awaits, so releases can land mid-setup.
  const heldRef = useRef(false)

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      const up = await probeService()
      if (!alive) return
      setService(up ? 'ok' : 'down')
      timer = window.setTimeout(
        () => { void tick() },
        up ? SERVICE_RECHECK_MS : SERVICE_RETRY_MS,
      )
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => setError(null), 5000)
    return () => window.clearTimeout(timer)
  }, [error])

  // Session switches unmount this entry; never leave the mic open behind us.
  useEffect(() => () => {
    void sessionRef.current?.cancel()
    sessionRef.current = null
  }, [])

  const begin = (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (phase !== 'idle') return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    heldRef.current = true
    setError(null)
    void (async () => {
      // Never refuse on a stale 'down': re-check the service right now.
      if (service === 'down') {
        if (!(await probeService())) {
          heldRef.current = false
          setError({
            message: '语音服务不可用：请确认 dsh 已带本插件启动（127.0.0.1:18765）',
            seq: Date.now(),
          })
          return
        }
        if (!heldRef.current) return
        setService('ok')
      }
      try {
        const session = await openMic()
        // Released while probing/opening: drop the mic instead of recording forever.
        if (!heldRef.current) {
          void session.cancel()
          return
        }
        sessionRef.current = session
        startedAtRef.current = Date.now()
        setPhase('recording')
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : String(err), seq: Date.now() })
      }
    })()
  }

  const finish = (): void => {
    heldRef.current = false
    if (phase !== 'recording') return
    const session = sessionRef.current
    sessionRef.current = null
    const elapsed = Date.now() - startedAtRef.current
    setPhase('recognizing')
    void (async () => {
      try {
        let samples: Float32Array | null = null
        if (elapsed >= MIN_RECORD_MS) samples = await session?.stop() ?? null
        else await session?.cancel()
        if (samples === null || samples.length < 800) {
          setError({
            message: elapsed < MIN_RECORD_MS ? '按住说话，松开结束' : '未识别到语音内容',
            seq: Date.now(),
          })
          return
        }
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), ASR_TIMEOUT_MS)
        let res: Response
        try {
          res = await fetch(`${ASR_BASE}/asr`, {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: encodeWav(samples, 16000),
            signal: controller.signal,
          })
        } catch (err) {
          const aborted = err instanceof DOMException && err.name === 'AbortError'
          throw new Error(aborted ? '识别超时，请重试' : '无法连接语音服务 (127.0.0.1:18765)')
        } finally {
          window.clearTimeout(timer)
        }
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (!res.ok || data === null) {
          const message = data?.code === 'downloading'
            ? `模型下载中 ${String(data.percent ?? 0)}%，请稍候再试`
            : typeof data?.error === 'string'
              ? data.error
              : `语音服务错误 (HTTP ${String(res.status)})`
          setError({ message, seq: Date.now() })
          return
        }
        const text = String(data.text ?? '').trim()
        if (text === '') {
          setError({ message: '未识别到语音内容', seq: Date.now() })
          return
        }
        const fallback: DraftSnapshot = { draft: input?.draft ?? '', draftRev: input?.draftRev ?? 0 }
        if (!insert(text, fallback)) {
          setError({ message: '插入草稿失败：草稿已变化，请重试', seq: Date.now() })
        }
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : String(err), seq: Date.now() })
      } finally {
        setPhase('idle')
      }
    })()
  }

  const title = phase === 'recording'
    ? '松开结束录音 / Release to stop'
    : phase === 'recognizing'
      ? '识别中…'
      : '按住说话 / Hold to talk'

  const wrapStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  }

  const buttonStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: phase === 'recording' ? '2px solid #ef4444' : '1px solid transparent',
    background: phase === 'recognizing' ? 'rgba(148, 163, 184, 0.25)' : 'rgba(148, 163, 184, 0.14)',
    color: phase === 'recording' ? '#ef4444' : '#64748b',
    cursor: phase === 'recognizing' ? 'wait' : 'pointer',
    padding: 0,
    margin: 0,
    touchAction: 'none',
    userSelect: 'none',
    opacity: phase === 'recognizing' ? 0.85 : 1,
  }

  const bubbleStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    right: 0,
    maxWidth: 280,
    background: 'rgba(15, 23, 42, 0.92)',
    color: '#f8fafc',
    fontSize: 12,
    lineHeight: 1.5,
    padding: '6px 10px',
    borderRadius: 8,
    pointerEvents: 'none',
    whiteSpace: 'normal',
    zIndex: 50,
  }

  return React.createElement(
    'div',
    { style: wrapStyle },
    React.createElement(
      'button',
      {
        type: 'button',
        'aria-label': title,
        title,
        'aria-pressed': phase === 'recording',
        'aria-busy': phase === 'recognizing',
        disabled: phase === 'recognizing',
        className: phase === 'recording' ? 'dshv-rec' : undefined,
        style: buttonStyle,
        onPointerDown: begin,
        onPointerUp: finish,
        onPointerCancel: finish,
        onContextMenu: (event) => { event.preventDefault() },
      },
      phase === 'recognizing' ? SPINNER : MIC_ICON,
    ),
    error === null
      ? null
      : React.createElement('div', { role: 'status', style: bubbleStyle }, error.message),
  )
}

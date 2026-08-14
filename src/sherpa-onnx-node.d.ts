declare module 'sherpa-onnx-node' {
  /** One offline recognition stream bound to a recognizer. */
  export interface OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
    setOption(key: string, value: string): void
  }

  /** Result of an offline decode. */
  export interface OfflineRecognizerResult {
    text?: string
    tokens?: string[]
    lang?: string
    emotion?: string
    event?: string
  }

  /** Recognizer config; the senseVoice arm mirrors the C++ OfflineSenseVoiceModelConfig. */
  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate: number; featureDim: number }
    modelConfig?: {
      senseVoice?: { model: string; language?: string; useInverseTextNormalization?: number }
      tokens?: string
      numThreads?: number
      debug?: number | boolean
      provider?: string
    }
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>
    getResult(stream: OfflineStream): OfflineRecognizerResult
    setConfig(config: OfflineRecognizerConfig): void
  }
}

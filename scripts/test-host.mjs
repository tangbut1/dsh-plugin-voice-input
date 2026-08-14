/**
 * Standalone smoke test for the host half (no dsh boot needed):
 * mounts lib/index.js with a minimal fake ctx, then exercises
 * GET /health and POST /asr against the loopback service.
 *
 *   node scripts/test-host.mjs [path-to.wav]
 */
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const disposers = []
const ctx = {
  effect(fn, label) {
    console.log('[test] effect:', label)
    const disposer = fn()
    disposers.push(() => { try { disposer?.() } catch { /* closed twice is fine */ } })
  },
  logger: { info: console.log, warn: console.warn, error: console.error },
}

apply(ctx)

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new Error('ASR service did not come up on 127.0.0.1:18765')
}

const health = await waitFor('http://127.0.0.1:18765/health')
console.log('GET /health', health.status, JSON.stringify(await health.json()))

const bad = await fetch('http://127.0.0.1:18765/asr', {
  method: 'POST',
  headers: { 'content-type': 'audio/wav' },
  body: 'this is not a wav',
})
console.log('POST /asr (bad wav)', bad.status, JSON.stringify(await bad.json()))

const wavPath = process.argv[2]
if (wavPath !== undefined) {
  const res = await fetch('http://127.0.0.1:18765/asr', {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: readFileSync(wavPath),
  })
  console.log(`POST /asr (${wavPath})`, res.status, JSON.stringify(await res.json()))
}

for (const disposer of disposers) disposer()
console.log('[test] disposed')

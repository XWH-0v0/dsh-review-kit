/**
 * Adversarial verification.
 *
 * Every finding gets independent verifiers whose only job is to *falsify* it.
 * A verifier that cannot be reached is not a pass: the configured policy
 * (`refute` by default, or `observation`) decides the finding's fate, and that
 * policy is never chosen ad hoc inside the loop.
 *
 * @module dsh-review-kit/verify
 */

import { buildVerifierPrompt } from './prompt.js'
import { VERDICT_SCHEMA } from './schema.js'

const ORIGINS = new Set(['introduced', 'preexisting', 'unknown'])

/**
 * @param {unknown} value candidate number.
 * @returns {number} a number in 0..1.
 */
function clampConfidence(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/**
 * Normalize one structured verdict returned by a verifier.
 *
 * @param {unknown} raw verifier output.
 * @returns {{confirmed: boolean, confidence: number, reasoning: string, reproduced: boolean, origin: string}} a verdict.
 */
export function normalizeVerdict(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const reasoning = typeof input.reasoning === 'string' ? input.reasoning.slice(0, 4_000) : ''
  const origin = typeof input.origin === 'string' && ORIGINS.has(input.origin) ? input.origin : 'unknown'
  return {
    confirmed: input.confirmed === true,
    confidence: clampConfidence(input.confidence),
    reasoning,
    reproduced: input.reproduced === true,
    origin,
  }
}

/**
 * @param {Array<{origin: string}>} verdicts verdicts that agreed.
 * @returns {string} the shared origin, or `unknown` when they disagree.
 */
function agreedOrigin(verdicts) {
  if (verdicts.length === 0) return 'unknown'
  const first = verdicts[0].origin
  return verdicts.every((verdict) => verdict.origin === first) ? first : 'unknown'
}

/**
 * Verify every finding inside the shared child budget.
 *
 * @param {object} options verification options.
 * @param {object[]} options.findings capped, sorted findings.
 * @param {object} options.snapshot review snapshot (for code context).
 * @param {string} options.root repository root.
 * @param {string} options.baselineRef baseline revision for origin hints.
 * @param {object} options.config resolved config.
 * @param {Function} options.runChild child runner.
 * @param {{run: Function}} options.limiter shared limiter.
 * @param {AbortSignal} options.signal cancellation.
 * @returns {Promise<{findings: object[], verifiersRun: number, verifiersFailed: Array<{id: string, reason: string}>, childRuns: number}>} verification outcome.
 */
export async function verifyFindings({
  findings,
  snapshot,
  root,
  baselineRef,
  config,
  runChild,
  limiter,
  signal,
}) {
  const files = new Map(snapshot.files.map((file) => [file.path, file]))
  let childRuns = 0
  let verifiersRun = 0
  const verifiersFailed = []

  const verified = await Promise.all(findings.map((finding) => limiter.run(async () => {
    if (signal.aborted) {
      return {
        ...finding,
        status: 'unverified',
        confidence: 0,
        origin: 'unknown',
        verifications: [],
        refutation: '已中断，复核未完成',
      }
    }

    const prompt = buildVerifierPrompt({
      finding,
      file: files.get(finding.file) ?? null,
      root,
      baselineRef,
    })
    const verdicts = []
    const failures = []

    for (let attempt = 0; attempt < config.verifiersPerFinding; attempt += 1) {
      childRuns += 1
      try {
        const out = await runChild({
          label: `review:verify:${finding.id}:${attempt + 1}`,
          prompt,
          outputSchema: VERDICT_SCHEMA,
        })
        if (out.stopReason !== 'completed') {
          throw new Error(`复核者未完成（stopReason=${String(out.stopReason)}）${out.diagnostic ? `：${out.diagnostic}` : ''}`)
        }
        if (out.structured === null || typeof out.structured !== 'object') {
          throw new Error('复核者没有返回结构化结论')
        }
        const verdict = normalizeVerdict(out.structured)
        verdicts.push(verdict)
        verifiersRun += 1
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(reason)
        verifiersFailed.push({ id: finding.id, reason })
      }
    }

    if (verdicts.length < config.verifiersPerFinding) {
      const reason = failures.join('；') || '复核者不可用'
      if (config.onVerifierFailure === 'observation') {
        return {
          ...finding,
          status: 'unverified',
          confidence: 0,
          origin: 'unknown',
          verifications: verdicts,
          refutation: `复核不可用，降级为未验证：${reason}`,
        }
      }
      return {
        ...finding,
        status: 'refuted',
        confidence: 0,
        origin: 'unknown',
        verifications: verdicts,
        refutation: `复核者不可用，按未通过处理：${reason}`,
      }
    }

    const confidence = verdicts.reduce((sum, verdict) => sum + verdict.confidence, 0) / verdicts.length
    const refuting = verdicts.filter((verdict) => !verdict.confirmed)
    if (refuting.length === 0) {
      return {
        ...finding,
        status: 'confirmed',
        confidence,
        origin: agreedOrigin(verdicts),
        verifications: verdicts,
        reproduced: verdicts.some((verdict) => verdict.reproduced),
      }
    }
    return {
      ...finding,
      status: 'refuted',
      confidence,
      origin: 'unknown',
      verifications: verdicts,
      refutation: refuting.map((verdict) => verdict.reasoning).filter((text) => text.length > 0).join(' / ').slice(0, 2_000),
    }
  })))

  return { findings: verified, verifiersRun, verifiersFailed, childRuns }
}

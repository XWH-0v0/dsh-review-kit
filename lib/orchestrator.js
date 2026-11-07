/**
 * The review pipeline.
 *
 *   target → snapshot → budget → find (lenses) → gate → dedupe → cap
 *          → verify (adversarial) → attribute → render
 *
 * Every phase degrades instead of exploding: a failed lens is a coverage gap, a
 * rejected anchor is invalid output, an unavailable verifier follows policy,
 * and an aborted run still returns what it completed. Only the case where *no*
 * lens produced anything raises.
 *
 * @module dsh-review-kit/orchestrator
 */

import { planBudget } from './budget.js'
import { createLimiter } from './concurrency.js'
import { isDocPath, normalizeLenses } from './config.js'
import { dedupeFindings } from './dedupe.js'
import { dispatchFinders } from './dispatch.js'
import { gateCandidates } from './gate.js'
import { createGit } from './git.js'
import { lensList } from './lenses.js'
import { buildFileSection } from './prompt.js'
import { renderMarkdown } from './render.js'
import { buildSnapshot, resolveRepoRoot } from './snapshot.js'
import { describeTarget, parseTarget } from './target.js'
import { compareFindings, normalizeLine, splitLines } from './text.js'
import { verifyFindings } from './verify.js'

/**
 * @param {'introduced'|'preexisting'|'unknown'} origin normalized origin.
 * @returns {string} the origin, unchanged.
 */
function originOf(origin) {
  return ['introduced', 'preexisting', 'unknown'].includes(origin) ? origin : 'unknown'
}

/**
 * Baseline hint for one finding. A matching line in the baseline is only a
 * hint: the verifier decides whether the *defect* predates the change.
 *
 * @param {object} finding gated finding.
 * @param {object} snapshot review snapshot.
 * @returns {'possibly-preexisting'|'new'|'unknown'} the hint.
 */
function originHintOf(finding, snapshot) {
  const file = snapshot.files.find((entry) => entry.path === finding.file)
  if (file === undefined) return 'unknown'
  if (file.before === null) return 'new'
  const want = normalizeLine(finding.anchor)
  const lines = splitLines(file.before)
  for (const line of lines) {
    if (normalizeLine(line) === want) return 'possibly-preexisting'
  }
  return 'new'
}

/**
 * @param {object} finding confirmed finding.
 * @returns {object} the value shape declared by OUTPUT_SCHEMA.
 */
function toConfirmedValue(finding) {
  return {
    id: finding.id,
    file: finding.file,
    line: finding.line,
    anchor: finding.anchor,
    kind: finding.kind,
    title: finding.title,
    detail: finding.detail,
    failureScenario: finding.failureScenario,
    severity: finding.severity,
    lens: finding.lens,
    lenses: [...finding.lenses],
    origin: originOf(finding.origin),
    originHint: finding.originHint ?? 'unknown',
    confidence: Number.isFinite(finding.confidence) ? finding.confidence : 0,
    ...(typeof finding.suggestedFix === 'string' && finding.suggestedFix.length > 0 ? { suggestedFix: finding.suggestedFix } : {}),
    status: 'confirmed',
    verifications: finding.verifications.map((verdict) => ({
      confirmed: verdict.confirmed === true,
      confidence: Number.isFinite(verdict.confidence) ? verdict.confidence : 0,
      reasoning: verdict.reasoning,
      reproduced: verdict.reproduced === true,
      origin: originOf(verdict.origin),
    })),
  }
}

/**
 * @param {object} finding rejected or unverified finding.
 * @returns {object} the value shape declared by OUTPUT_SCHEMA.
 */
function toRejectedValue(finding) {
  return {
    id: finding.id,
    file: finding.file,
    line: finding.line,
    anchor: finding.anchor,
    title: finding.title,
    severity: finding.severity,
    lens: finding.lens,
    lenses: [...finding.lenses],
    reason: finding.refutation ?? '',
    confidence: Number.isFinite(finding.confidence) ? finding.confidence : 0,
  }
}

/**
 * @param {object} options abort context.
 * @param {string} options.targetDescription scope line.
 * @param {object} options.config resolved config.
 * @param {number} options.startedAt epoch milliseconds.
 * @param {string} options.reason readable reason.
 * @returns {object} a schema-valid aborted result.
 */
function abortedValue({ targetDescription, config, startedAt, reason }) {
  const coverage = {
    target: targetDescription,
    depth: config.depth,
    lensesRun: [],
    lensesFailed: [],
    lensesClean: [],
    filesReviewed: [],
    filesSkipped: [],
    findingsFound: 0,
    findingsInvalid: [],
    findingsDeduped: 0,
    findingsDropped: [],
    verifiersRun: 0,
    verifiersFailed: [],
    aborted: true,
    truncated: false,
    durationMs: Date.now() - startedAt,
    childRuns: 0,
    notes: [reason],
  }
  const stats = { candidates: 0, valid: 0, invalid: 0, deduped: 0, dropped: 0, verified: 0, confirmed: 0, refuted: 0, unverified: 0 }
  return {
    ok: true,
    status: 'aborted',
    markdown: renderMarkdown({
      status: 'aborted',
      targetDescription,
      confirmed: [],
      refuted: [],
      unverified: [],
      coverage,
      stats,
    }),
    confirmed: [],
    refuted: [],
    unverified: [],
    coverage,
    stats,
  }
}

/**
 * Run one review.
 *
 * @param {object} options review options.
 * @param {Record<string, unknown>} options.args model arguments.
 * @param {object} options.config resolved config.
 * @param {Function} options.runChild child runner: `{label, prompt, outputSchema} → {stopReason, structured, diagnostic}`.
 * @param {string} options.cwd starting directory (usually the session working directory).
 * @param {AbortSignal} options.signal cancellation, forwarded to every child.
 * @param {object} [options.ctx] host plugin context, for the shell-tool git path.
 * @param {{agent?: object}} [options.exec] current tool execution.
 * @param {{info?: Function, warn?: Function}} [options.logger] logger.
 * @returns {Promise<object>} the tool output value.
 */
export async function runReview({ args, config, runChild, cwd, signal, ctx, exec, logger }) {
  const startedAt = Date.now()
  const target = parseTarget(args)
  const targetDescription = describeTarget(target)
  const requestedLenses = normalizeLenses(Array.isArray(args?.lenses) && args.lenses.length > 0 ? args.lenses : config.lenses)

  if (signal?.aborted) {
    return abortedValue({ targetDescription, config, startedAt, reason: '开始前用户已中断' })
  }

  const probeGit = createGit({ cwd, ctx, exec, config, logger })
  let root = await resolveRepoRoot(probeGit, cwd, { signal })
  if (root === null) root = cwd
  const git = root === cwd ? probeGit : createGit({ cwd: root, ctx, exec, config, logger })

  let snapshot
  try {
    snapshot = await buildSnapshot({ root, git, target, config, signal })
  } catch (error) {
    if (signal?.aborted) {
      return abortedValue({ targetDescription, config, startedAt, reason: '读取改动时被中断' })
    }
    throw error
  }

  if (snapshot.files.length === 0) {
    const docOnly = snapshot.skipped.length > 0 && snapshot.skipped.every((item) => isDocPath(item.path))
    if (docOnly) {
      throw new Error('这次改动只包含文档文件，不触发代码评审。如果确实需要评审文档，请用 target="files" 显式列出并说明原因。')
    }
    const reasons = snapshot.skipped.slice(0, 8).map((item) => `${item.path}（${item.reason}）`).join('；')
    throw new Error(`没有可评审的文件（起始目录 ${root}）。${reasons.length > 0 ? `被跳过：${reasons}` : ''}`)
  }

  const fileSection = buildFileSection(snapshot, config)
  if (fileSection.blocks.length === 0) {
    throw new Error('没有可评审的文件：全部超出单次评审的文本预算。请缩小范围（target="files" 或 depth="quick"）。')
  }

  const requestedDepth = args?.depth === 'quick' || args?.depth === 'full' ? args.depth : config.depth
  const requestedMaxFindings = Number.isInteger(args?.maxFindings) && args.maxFindings > 0
    ? Math.min(args.maxFindings, 60)
    : config.maxFindings
  const plan = planBudget({
    depth: requestedDepth,
    lensCount: requestedLenses.length,
    maxFindings: requestedMaxFindings,
    config,
  })
  const lenses = lensList(requestedLenses.slice(0, plan.lensLimit))

  const coverage = {
    target: targetDescription,
    ...(target.kind === 'base' ? { baseRef: target.baseRef } : {}),
    depth: plan.depth,
    lensesRun: [],
    lensesFailed: [],
    lensesClean: [],
    filesReviewed: fileSection.reviewed,
    filesSkipped: [...snapshot.skipped, ...fileSection.skipped],
    findingsFound: 0,
    findingsInvalid: [],
    findingsDeduped: 0,
    findingsDropped: [],
    verifiersRun: 0,
    verifiersFailed: [],
    aborted: false,
    truncated: snapshot.truncated || fileSection.truncated,
    durationMs: 0,
    childRuns: 0,
    notes: [],
  }
  if (plan.downgradeReason !== null) coverage.notes.push(plan.downgradeReason)
  if (coverage.truncated) coverage.notes.push('部分文件或改动文本因预算未进入评审（见「跳过」）')

  const limiter = createLimiter(config.maxConcurrentChildren)

  // ---- find -------------------------------------------------------------
  const finderResult = await dispatchFinders({
    lenses,
    targetDescription,
    root,
    fileSection,
    config,
    runChild,
    limiter,
    signal,
  })
  coverage.lensesRun = lenses.map((lens) => lens.key)
  coverage.lensesFailed = finderResult.failed
  coverage.childRuns += finderResult.childRuns
  coverage.findingsFound = finderResult.candidates.length

  // ---- gate -------------------------------------------------------------
  const gate = gateCandidates({ candidates: finderResult.candidates, snapshot })
  coverage.findingsInvalid = gate.invalid

  const { findings: deduped, mergedCount } = dedupeFindings(gate.accepted)
  coverage.findingsDeduped = mergedCount

  const contributed = new Set(gate.accepted.map((finding) => finding.lens))
  const failedLenses = new Set(coverage.lensesFailed.map((item) => item.lens))
  coverage.lensesClean = lenses
    .map((lens) => lens.key)
    .filter((key) => !failedLenses.has(key) && !contributed.has(key))

  if (coverage.lensesFailed.length === lenses.length && !signal?.aborted) {
    const details = coverage.lensesFailed.map((item) => `- ${item.lens}: ${item.reason}`).join('\n')
    throw new Error(`所有评审视角都失败了，本次没有可信结果：\n${details}`)
  }

  // ---- cap --------------------------------------------------------------
  const sorted = [...deduped].sort(compareFindings)
  const capped = sorted.slice(0, plan.verifiedLimit)
  for (const finding of sorted.slice(plan.verifiedLimit)) {
    coverage.findingsDropped.push({
      file: finding.file,
      title: finding.title,
      reason: `超出 ${plan.depth} 深度的复核上限（${plan.verifiedLimit} 条）`,
    })
  }
  for (const finding of capped) finding.originHint = originHintOf(finding, snapshot)

  // ---- verify -----------------------------------------------------------
  const verification = await verifyFindings({
    findings: capped,
    snapshot,
    root,
    baselineRef: snapshot.beforeRef,
    config: { ...config, verifiersPerFinding: plan.verifiersPerFinding },
    runChild,
    limiter,
    signal,
  })
  coverage.childRuns += verification.childRuns
  coverage.verifiersRun = verification.verifiersRun
  coverage.verifiersFailed = verification.verifiersFailed
  coverage.aborted = signal?.aborted === true

  const confirmed = verification.findings.filter((finding) => finding.status === 'confirmed')
  const refuted = verification.findings.filter((finding) => finding.status === 'refuted')
  const unverified = verification.findings.filter((finding) => finding.status === 'unverified')
  const stats = {
    candidates: coverage.findingsFound,
    valid: gate.accepted.length,
    invalid: gate.invalid.length,
    deduped: coverage.findingsDeduped,
    dropped: coverage.findingsDropped.length,
    verified: capped.length,
    confirmed: confirmed.length,
    refuted: refuted.length,
    unverified: unverified.length,
  }

  coverage.durationMs = Date.now() - startedAt
  const status = coverage.aborted
    ? 'aborted'
    : (coverage.lensesFailed.length > 0 || coverage.findingsDropped.length > 0 || coverage.truncated ? 'partial' : 'completed')

  const markdown = renderMarkdown({
    status,
    targetDescription,
    confirmed,
    refuted,
    unverified,
    coverage,
    stats,
  })

  logger?.info?.(`[review-kit] ${status}: ${confirmed.length} confirmed / ${refuted.length} refuted / ${unverified.length} unverified (${coverage.childRuns} children, ${coverage.durationMs}ms)`)

  return {
    ok: true,
    status,
    markdown,
    confirmed: confirmed.map(toConfirmedValue),
    refuted: refuted.map(toRejectedValue),
    unverified: unverified.map(toRejectedValue),
    coverage,
    stats,
  }
}

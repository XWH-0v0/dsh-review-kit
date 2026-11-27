/**
 * End-to-end harness for the review pipeline.
 *
 * It runs the real target → snapshot → gate → dedupe → verify → render path
 * against the fixture project, but replaces the LLM children with a scripted
 * runner. That keeps the orchestration, the evidence gate and the report
 * deterministic and free, while the actual child quality stays a model problem.
 *
 * Run: node test/e2e/run.mjs
 */

import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createReviewClock } from '../../lib/clock.js'
import { resolveConfig } from '../../lib/config.js'
import { runReview } from '../../lib/orchestrator.js'
import { OUTPUT_SCHEMA } from '../../lib/schema.js'
import { normalizeLine, splitLines } from '../../lib/text.js'
import { validateSchema } from '../support/validate.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/buggy-project', import.meta.url))
const FILES = ['src/pagination.js', 'src/cache.js', 'src/auth.js']

const PAGINATION = {
  file: 'src/pagination.js',
  anchor: '  for (let index = offset; index <= offset + limit; index += 1) {',
  kind: 'correctness',
  title: '分页多返回一条',
  detail: '`<= offset + limit` 让循环多走一次。',
  failureScenario: 'pageOf([1,2,3], 0, 2) → 返回 3 条',
  severity: 'major',
}

const CACHE = {
  file: 'src/cache.js',
  anchor: '    return this.entries.get(key).value',
  kind: 'correctness',
  title: '缺失键会抛 TypeError',
  detail: 'get() 没有检查 Map 是否命中。',
  failureScenario: 'get("absent") → TypeError: Cannot read properties of undefined',
  severity: 'critical',
}

const AUTH = {
  file: 'src/auth.js',
  anchor: "  if (!session.approval) return 'allow'",
  kind: 'security',
  title: 'approval 缺失时静默放行',
  detail: '字段缺失走了 allow 分支。',
  failureScenario: 'session 不带 approval → 请求被静默放行',
  severity: 'critical',
}

const FABRICATED = {
  file: 'src/cache.js',
  anchor: '    return this.entries.get(key)?.value',
  kind: 'correctness',
  title: '编造的引用',
  detail: '这一行在快照里不存在。',
  failureScenario: '无',
  severity: 'major',
}

const STYLE = {
  file: 'src/auth.js',
  anchor: "  if (!session.approval) return 'allow'",
  kind: 'style',
  title: '命名不清晰',
  detail: '变量名太短。',
  failureScenario: '无',
  severity: 'minor',
}

/**
 * Scripted child runner. Finder output is fixed per lens; verifier output
 * depends on which finding it was asked about (identified by its prompt).
 */
function createScriptedRunner({ scripted, calls }) {
  return async function runChild({ label, prompt }) {
    calls.push(label)
    if (label.startsWith('review:find:')) {
      const lens = label.slice('review:find:'.length)
      const findings = lens === 'correctness'
        ? [CACHE, PAGINATION, FABRICATED, STYLE]
        : lens === 'security' ? [AUTH] : []
      return { stopReason: 'completed', structured: { findings } }
    }
    if (label.startsWith('review:verify:')) {
      const confirmed = /TypeError/.test(prompt) || /静默放行/.test(prompt)
      return {
        stopReason: 'completed',
        structured: {
          confirmed,
          confidence: confirmed ? 0.84 : 0.62,
          reasoning: confirmed
            ? '读了代码并构造了缺失字段，确实会抛出或放行。'
            : '构造了 offset=0、limit=2 的输入，未复现越界；闭区间写法与调用方一致。',
          reproduced: confirmed,
          origin: 'introduced',
        },
      }
    }
    throw new Error(`unexpected child label: ${label}`)
  }
}

async function withFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'review-kit-e2e-'))
  try {
    await cp(FIXTURE_DIR, dir, { recursive: true })
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const config = resolveConfig({ childTimeoutMs: 20_000 })

console.log('review-kit e2e: scripted pipeline')

await withFixture(async (cwd) => {
  const calls = []
  const runChild = createScriptedRunner({ calls })
  const result = await runReview({
    args: { target: 'files', files: FILES },
    config,
    runChild,
    cwd,
    signal: new AbortController().signal,
  })

  const errors = validateSchema(OUTPUT_SCHEMA, result)
  assert.deepEqual(errors, [], `输出不符合 OUTPUT_SCHEMA：\n${errors.join('\n')}`)
  assert.equal(result.status, 'completed')
  assert.equal(result.confirmed.length, 2, '应有 2 条确认（缓存 + 授权）')
  assert.equal(result.refuted.length, 1, '应有 1 条被推翻（分页）')
  assert.equal(result.coverage.findingsInvalid.length, 2, '应有 2 条无效引用（编造行 + style kind）')
  assert.deepEqual(result.confirmed.map((item) => item.file).sort(), ['src/auth.js', 'src/cache.js'])
  assert.equal(result.coverage.childRuns, 7, '4 个 finder + 3 个 verifier')
  assert.equal(result.coverage.filesReviewed.length, 3)
  assert.equal(result.stats.candidates, 5)
  assert.equal(result.stats.invalid, 2)
  assert.match(result.markdown, /## 代码评审：2 条确认/)
  assert.match(result.markdown, /覆盖/)
  assert.match(result.markdown, /无效引用 2/)

  // Every confirmed finding must point at the exact source line it quotes.
  for (const finding of result.confirmed) {
    assert.ok(finding.line > 0, `${finding.file} 没有解析出行号`)
    const text = await readFile(join(cwd, finding.file), 'utf8')
    const line = splitLines(text)[finding.line - 1]
    assert.equal(normalizeLine(line), normalizeLine(finding.anchor), '保存的行号与引用不符')
    assert.equal(finding.origin, 'introduced')
    assert.ok(finding.verifications.length >= 1)
  }

  console.log(`  confirmed=${result.confirmed.length} refuted=${result.refuted.length} invalid=${result.coverage.findingsInvalid.length} children=${result.coverage.childRuns}`)
})

await withFixture(async (cwd) => {
  const empty = async ({ label }) => ({ stopReason: 'completed', structured: label.startsWith('review:find:') ? { findings: [] } : null })
  const result = await runReview({ args: { target: 'files', files: FILES }, config, runChild: empty, cwd, signal: new AbortController().signal })
  assert.equal(result.status, 'completed')
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.coverage.lensesClean.length, 4)
  assert.match(result.markdown, /没有可确认的问题/)
  assert.match(result.markdown, /不等于「没有问题」/)
  console.log('  clean run keeps coverage explicit')
})

await withFixture(async (cwd) => {
  // Per-lens truncation is a coverage fact, not a silent cleanup.
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...CACHE, title: `候选 ${index}` }))
  const runChild = ({ label }) => {
    if (label.startsWith('review:find:')) {
      return Promise.resolve({
        stopReason: 'completed',
        structured: { findings: label.endsWith('correctness') ? nine : [] },
      })
    }
    return Promise.resolve({ stopReason: 'completed', structured: { confirmed: true, confidence: 0.8, reasoning: 'ok', reproduced: false, origin: 'introduced' } })
  }
  const result = await runReview({
    args: { target: 'files', files: ['src/cache.js'] },
    config,
    runChild,
    cwd,
    signal: new AbortController().signal,
  })
  assert.equal(result.stats.candidates, config.maxCandidatesPerLens, '每视角只保留上限内的候选')
  assert.match(result.coverage.notes.join(' '), /候选截断/, '截断必须写进 coverage.notes')
  assert.match(result.markdown, /候选截断/, '报告里也要能看到')
  console.log('  per-lens truncation is reported as a coverage note')
})

await withFixture(async (cwd) => {
  // Two lenses, one line, two kinds: two independent claims, each verified, and
  // the report groups them by location instead of printing a duplicate.
  const sibling = { ...CACHE, kind: 'state', title: '缓存未命中状态没有被表达' }
  let verifiers = 0
  const runChild = ({ label }) => {
    if (label.startsWith('review:find:')) {
      const findings = label === 'review:find:correctness' ? [CACHE] : label === 'review:find:lifecycle' ? [sibling] : []
      return Promise.resolve({ stopReason: 'completed', structured: { findings } })
    }
    verifiers += 1
    return Promise.resolve({ stopReason: 'completed', structured: { confirmed: true, confidence: 0.8, reasoning: 'ok', reproduced: false, origin: 'introduced' } })
  }
  const result = await runReview({
    args: { target: 'files', files: ['src/cache.js'] },
    config,
    runChild,
    cwd,
    signal: new AbortController().signal,
  })
  assert.equal(result.stats.confirmed, 2, '同一行的两条结论都要确认')
  assert.equal(verifiers, 2, '两条结论各自复核，不能合并成一次判决')
  assert.match(result.markdown, /2 条确认（1 处代码位置）/)
  assert.match(result.markdown, /同一代码行的其他独立结论/)
  console.log('  same-line claims stay separate and are grouped in the report')
})

await withFixture(async (cwd) => {
  const controller = new AbortController()
  controller.abort()
  const result = await runReview({
    args: { target: 'files', files: FILES },
    config,
    runChild: async () => ({ stopReason: 'completed', structured: { findings: [] } }),
    cwd,
    signal: controller.signal,
  })
  assert.equal(result.status, 'aborted')
  assert.equal(result.coverage.aborted, true)
  assert.deepEqual(validateSchema(OUTPUT_SCHEMA, result), [])
  console.log('  aborted run returns a partial, schema-valid result')
})

await withFixture(async (cwd) => {
  const clock = createReviewClock(new AbortController().signal, 1_000)
  // The clock timer is unref'd (like the per-child budget), so a short-lived
  // process needs its own keep-alive until the deadline fires.
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    const hanging = () => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('已中断'))
      if (clock.signal.aborted) onAbort()
      else clock.signal.addEventListener('abort', onAbort, { once: true })
    })
    const result = await runReview({
      args: { target: 'files', files: FILES },
      config: { ...config, softTimeoutMs: 1_000 },
      runChild: hanging,
      cwd,
      signal: clock.signal,
      clock,
    })
    assert.equal(result.status, 'aborted')
    assert.equal(result.coverage.aborted, true)
    assert.equal(result.coverage.abortedBy, 'timeout')
    assert.match(result.coverage.notes.join(' '), /评审整体超时/)
    assert.match(result.markdown, /已超时/)
    assert.doesNotMatch(result.markdown, /用户中断/)
    assert.deepEqual(validateSchema(OUTPUT_SCHEMA, result), [])
    console.log('  whole-review clock cancels children and returns a partial report')
  } finally {
    clearInterval(keepAlive)
    clock.dispose()
  }
})

await withFixture(async (cwd) => {
  const controller = new AbortController()
  const pending = runReview({
    args: { target: 'files', files: FILES },
    config,
    runChild: async () => ({ stopReason: 'completed', structured: { findings: [] } }),
    cwd,
    signal: controller.signal,
  })
  controller.abort(new Error('用户中断'))
  const result = await pending
  assert.equal(result.status, 'aborted')
  assert.equal(result.coverage.abortedBy, 'caller')
  assert.match(result.coverage.notes.join(' '), /中断/)
  assert.deepEqual(validateSchema(OUTPUT_SCHEMA, result), [])
  console.log('  abort during snapshot settles as an aborted report, not a throw')
})

await withFixture(async (cwd) => {
  const clock = createReviewClock(new AbortController().signal, 800)
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    const runChild = ({ label }) => {
      if (label.startsWith('review:find:')) {
        return Promise.resolve({ stopReason: 'completed', structured: { findings: [CACHE] } })
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('已中断'))
        if (clock.signal.aborted) onAbort()
        else clock.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    const result = await runReview({
      args: { target: 'files', files: ['src/cache.js'] },
      config: { ...config, softTimeoutMs: 800 },
      runChild,
      cwd,
      signal: clock.signal,
      clock,
    })
    assert.equal(result.status, 'aborted')
    assert.equal(result.coverage.abortedBy, 'timeout')
    assert.equal(result.stats.refuted, 0, '超时不能让未完成的复核变成“被推翻”')
    assert.equal(result.stats.unverified, 1)
    assert.doesNotMatch(result.markdown, /复核给出了反证/)
    console.log('  clock expiry during verification marks unfinished findings unverified')
  } finally {
    clearInterval(keepAlive)
    clock.dispose()
  }
})

await withFixture(async (cwd) => {
  const clock = createReviewClock(new AbortController().signal, 400)
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    const hanging = () => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('已中断'))
      if (clock.signal.aborted) onAbort()
      else clock.signal.addEventListener('abort', onAbort, { once: true })
    })
    const result = await runReview({
      args: { target: 'files', files: FILES },
      config: { ...config, softTimeoutMs: 400, maxConcurrentChildren: 1 },
      runChild: hanging,
      cwd,
      signal: clock.signal,
      clock,
    })
    assert.equal(result.status, 'aborted')
    const reasons = result.coverage.lensesFailed.map((item) => item.reason)
    assert.equal(reasons.length, 4)
    assert.ok(reasons.some((reason) => /整轮超时，未开始/.test(reason)), `排队视角应报超时，实际：${reasons.join(' / ')}`)
    console.log('  queued lenses report the review timeout, not a caller cancel')
  } finally {
    clearInterval(keepAlive)
    clock.dispose()
  }
})

await withFixture(async (cwd) => {
  const controller = new AbortController()
  const seen = []
  const runChild = ({ label }) => {
    seen.push(label)
    if (label.startsWith('review:find:')) {
      return Promise.resolve({ stopReason: 'completed', structured: { findings: [CACHE] } })
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('已中断'))
      if (controller.signal.aborted) onAbort()
      else controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  const pending = runReview({
    args: { target: 'files', files: ['src/cache.js'] },
    config,
    runChild,
    cwd,
    signal: controller.signal,
  })
  const deadline = Date.now() + 5_000
  while (!seen.some((label) => label.startsWith('review:verify:')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  controller.abort(new Error('用户中断'))
  const result = await pending
  assert.equal(result.status, 'aborted')
  assert.equal(result.coverage.abortedBy, 'caller')
  assert.equal(result.stats.refuted, 0, '用户中断不能把复核结果算成“被推翻”')
  assert.equal(result.stats.unverified, 1)
  assert.doesNotMatch(result.markdown, /复核给出了反证/)
  console.log('  caller cancel during verification keeps findings unverified')
})

await withFixture(async (cwd) => {
  const clock = createReviewClock(new AbortController().signal, 400)
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    const hanging = () => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('已中断'))
      if (clock.signal.aborted) onAbort()
      else clock.signal.addEventListener('abort', onAbort, { once: true })
    })
    const result = await runReview({
      args: { target: 'files', files: FILES },
      config: { ...config, softTimeoutMs: 400 },
      runChild: hanging,
      cwd,
      signal: clock.signal,
      clock,
    })
    const reasons = result.coverage.lensesFailed.map((item) => item.reason)
    assert.equal(reasons.length, 4)
    assert.ok(reasons.every((reason) => /整轮超时，未完成/.test(reason)), `运行中的视角应报超时，实际：${reasons.join(' / ')}`)
    console.log('  in-flight lenses report the review timeout')
  } finally {
    clearInterval(keepAlive)
    clock.dispose()
  }
})

await withFixture(async (cwd) => {
  await assert.rejects(
    () => runReview({
      args: { target: 'files', files: ['README.md'] },
      config,
      runChild: async () => ({ stopReason: 'completed', structured: { findings: [] } }),
      cwd,
      signal: new AbortController().signal,
    }),
    /只包含文档文件/,
  )
  console.log('  documentation-only scope is refused')
})

console.log('review-kit e2e: OK')

/**
 * Contract tests for the child-agent runner.
 *
 * Regression guarded here: DSH 0.2.2-rc.5 flattened the activation spec.
 * `prompt`, `parent`, `outputSchema` and `maxDepth` are top-level fields of
 * `SubagentActivationSpec` (see `@deepseek-ai/dsh-subagent/src/types.ts`). The
 * old `request: {...}` wrapper left `spec.parent` undefined, so
 * `startActivation` threw `Cannot read properties of undefined (reading 'id')`
 * at its parent-identity check and every review lens died before a child
 * existed. The stand-in service below validates the spec the way the real
 * `startActivation` does (lib/index.js:3018-3036 in 0.2.2-rc.5).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG } from '../../lib/config.js'
import { createRunChild, resolveChildRoute } from '../../lib/subagents.js'

const CAPABILITIES = Object.freeze({
  agentOptions: true,
  agentPreset: true,
  outputSchema: true,
  depthLimit: true,
})

const OUTPUT_SCHEMA = Object.freeze({ type: 'object', properties: {}, required: [] })

/**
 * Stand-in `ctx.subagents` that rejects exactly what the real runtime rejects.
 *
 * @param {object} [options] fixture options.
 * @param {object} options.parent the live parent agent.
 * @param {object} [options.capabilities] provider capabilities.
 * @param {{stopReason: string, output: object[], structured?: unknown, diagnostic?: string}} [options.result] child result.
 * @param {Promise<unknown>} [options.pending] a result promise that never settles.
 * @returns {object} fake service exposing recorded specs and disposals.
 */
function createFakeSubagents({ parent, capabilities = CAPABILITIES, result, pending } = {}) {
  const specs = []
  const disposed = []
  const agents = new Map([[parent.id, parent]])
  const provider = { name: 'spawn', capabilities, inheritsParentContext: true }
  const settled = result ?? { stopReason: 'completed', output: [{ type: 'text', text: 'done' }], structured: { findings: [] } }

  return {
    specs,
    disposed,
    list: () => ['spawn'],
    getProvider: (name) => (name === 'spawn' ? provider : undefined),
    async startActivation(spec) {
      // lib/index.js:3019 — provider is resolved from the top level.
      assert.equal(spec.provider, 'spawn', 'provider 必须位于 spec 顶层')
      // lib/index.js:3021 — assertSubagentMaxDepth(spec.maxDepth).
      if (spec.maxDepth !== undefined && !(Number.isSafeInteger(spec.maxDepth) && spec.maxDepth >= 0)) {
        throw new RangeError('maxDepth 必须是非负安全整数')
      }
      // lib/index.js:3024 — the exact live parent check that used to crash.
      if (agents.get(spec.parent.id) !== spec.parent) {
        throw new Error('subagent creation requires the exact live parent agent')
      }
      // lib/index.js:3025 — assertObjectJsonSchema(spec.outputSchema).
      if (spec.outputSchema !== undefined && spec.outputSchema.type !== 'object') {
        throw new TypeError('outputSchema 必须是 object 根 schema')
      }
      specs.push(spec)
      return {
        childId: 'child-1',
        name: 'agent-1',
        result: pending ?? Promise.resolve(settled),
        async dispose() {
          disposed.push(spec)
        },
      }
    },
  }
}

/**
 * @param {object} service fake subagents service.
 * @param {object} options extra runner options.
 * @returns {Function} the child runner.
 */
function runnerFor(service, options) {
  const warnings = []
  return Object.assign(
    createRunChild({
      ctx: {
        get: (name) => (name === 'subagents' ? service : undefined),
        logger: { warn: (message) => warnings.push(message), info: () => {} },
      },
      config: options.config ?? { ...DEFAULT_CONFIG },
      parentAgent: options.parentAgent,
      cwd: options.cwd ?? 'C:/repo',
      signal: options.signal ?? new AbortController().signal,
    }),
    { warnings },
  )
}

test('startActivation 收到扁平 spec：parent/prompt/outputSchema/maxDepth 都在顶层', async () => {
  const parent = { id: 'parent-1' }
  const service = createFakeSubagents({ parent })
  const controller = new AbortController()
  const runChild = runnerFor(service, { parentAgent: parent, signal: controller.signal })

  const out = await runChild({ label: 'review:find:correctness', prompt: '看看这段改动', outputSchema: OUTPUT_SCHEMA })

  assert.equal(out.stopReason, 'completed')
  assert.equal(out.output, 'done')
  assert.deepEqual(out.structured, { findings: [] })
  assert.equal(service.specs.length, 1, '应恰好启动一个 activation')

  const spec = service.specs[0]
  assert.equal(spec.label, 'review:find:correctness')
  assert.equal(spec.parent, parent, 'parent 必须与发起调用的 agent 是同一个对象')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: '看看这段改动' }], 'prompt 必须位于 spec 顶层')
  assert.equal(spec.cwd, 'C:/repo')
  assert.equal(spec.outputSchema, OUTPUT_SCHEMA, 'outputSchema 必须位于 spec 顶层')
  assert.equal(spec.maxDepth, DEFAULT_CONFIG.childMaxDepth, 'maxDepth 必须位于 spec 顶层')
  assert.equal(spec.signal, controller.signal)
  assert.equal(spec.delivery, 'caller')
  assert.equal('request' in spec, false, '旧版 request 包装不应再出现')
})

test('provider 不支持 depthLimit 时不发送 maxDepth，未请求 schema 时不发送 outputSchema', async () => {
  const parent = { id: 'parent-1' }
  const service = createFakeSubagents({ parent, capabilities: { ...CAPABILITIES, depthLimit: false } })
  const runChild = runnerFor(service, { parentAgent: parent })

  await runChild({ label: 'review:verify:abc:1', prompt: '试着推翻它' })

  const spec = service.specs[0]
  assert.equal('maxDepth' in spec, false, '不支持 depthLimit 的 provider 不应收到 maxDepth')
  assert.equal('outputSchema' in spec, false, '未请求 schema 时不应发送 outputSchema')
})

test('provider 缺少 outputSchema 能力时在启动前拒绝', () => {
  const parent = { id: 'parent-1' }
  const service = createFakeSubagents({ parent, capabilities: { ...CAPABILITIES, outputSchema: false } })

  assert.throws(() => runnerFor(service, { parentAgent: parent }), /不支持结构化输出/)
  assert.equal(service.specs.length, 0)
})

test('子代理超时会取消 activation 并报错', async () => {
  const parent = { id: 'parent-1' }
  const keepAlive = setInterval(() => {}, 1_000)
  const service = createFakeSubagents({ parent, pending: new Promise(() => {}) })
  const runChild = createRunChild({
    ctx: { get: (name) => (name === 'subagents' ? service : undefined) },
    config: { ...DEFAULT_CONFIG, childTimeoutMs: 25 },
    parentAgent: parent,
    cwd: 'C:/repo',
    signal: new AbortController().signal,
  })

  try {
    await assert.rejects(() => runChild({ label: 'review:find:security', prompt: '慢' }), /子代理超时/)
  } finally {
    clearInterval(keepAlive)
  }
  assert.equal(service.disposed.length >= 1, true, '超时后必须 dispose 该 activation')
})
test('超时先按超时报错，即使 dispose 让 result 以 aborted 解析', async () => {
  const parent = { id: 'parent-1' }
  const keepAlive = setInterval(() => {}, 1_000)
  let resolveResult
  const result = new Promise((resolve) => { resolveResult = resolve })
  const service = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn', capabilities: CAPABILITIES }),
    async startActivation(spec) {
      assert.equal(spec.parent, parent)
      return {
        childId: 'child-1',
        result,
        // The real manager settles the child's result with `stopReason: 'aborted'`
        // when the activation is disposed. That used to win the race inside
        // withTimeout and turn a budget timeout into "子代理未完成（stopReason=aborted）".
        async dispose() { resolveResult({ stopReason: 'aborted', output: [] }) },
      }
    },
  }
  const runChild = createRunChild({
    ctx: { get: (name) => (name === 'subagents' ? service : undefined) },
    config: { ...DEFAULT_CONFIG, childTimeoutMs: 25 },
    parentAgent: parent,
    cwd: 'C:/repo',
    signal: new AbortController().signal,
  })

  try {
    await assert.rejects(() => runChild({ label: 'review:find:contract', prompt: '慢' }), /子代理超时/)
  } finally {
    clearInterval(keepAlive)
  }
})


test('调用方中断会取消 activation 并报已中断', async () => {
  const parent = { id: 'parent-1' }
  const controller = new AbortController()
  const service = createFakeSubagents({ parent, pending: new Promise(() => {}) })
  const runChild = runnerFor(service, { parentAgent: parent, signal: controller.signal })

  const running = runChild({ label: 'review:find:lifecycle', prompt: '慢' })
  controller.abort()

  await assert.rejects(() => running, /已中断/)
  assert.equal(service.disposed.length >= 1, true, '中断后必须 dispose 该 activation')
})

test('teardown 落定后 runChild 才 settle', async () => {
  const parent = { id: 'parent-1' }
  let finished = false
  const service = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn', capabilities: CAPABILITIES }),
    async startActivation(spec) {
      assert.equal(spec.parent, parent)
      return {
        childId: 'child-1',
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        async dispose() {
          await new Promise((resolve) => setTimeout(resolve, 20))
          finished = true
        },
      }
    },
  }
  const runChild = createRunChild({
    ctx: { get: (name) => (name === 'subagents' ? service : undefined) },
    config: { ...DEFAULT_CONFIG },
    parentAgent: parent,
    cwd: 'C:/repo',
    signal: new AbortController().signal,
  })

  const out = await runChild({ label: 'review:find:correctness', prompt: 'x' })
  assert.equal(out.stopReason, 'completed')
  assert.equal(finished, true, 'runChild settle 时 teardown 必须已落定')
})

test('resolveChildRoute 按 role 取路由，未知 role 不覆盖', () => {
  const config = {
    ...DEFAULT_CONFIG,
    finderEffort: 'low',
    verifierEffort: 'max',
    finderPreset: 'p-finder',
    verifierPreset: 'p-verifier',
    finderToolBudget: 3,
    verifierToolBudget: 4,
  }
  assert.deepEqual(resolveChildRoute(config, 'finder'), { effort: 'low', preset: 'p-finder', toolBudget: 3 })
  assert.deepEqual(resolveChildRoute(config, 'verifier'), { effort: 'max', preset: 'p-verifier', toolBudget: 4 })
  assert.deepEqual(resolveChildRoute(config, undefined), { effort: '', preset: '', toolBudget: 0 })
})

test('finder 与 verifier 子代理各自带上自己的 effort 与 preset', async () => {
  const parent = { id: 'parent-1' }
  const service = createFakeSubagents({ parent })
  const config = { ...DEFAULT_CONFIG, finderEffort: 'high', verifierEffort: 'max', finderPreset: 'review-readonly' }
  const runChild = runnerFor(service, { parentAgent: parent, config })

  await runChild({ label: 'review:find:correctness', prompt: 'x', role: 'finder' })
  await runChild({ label: 'review:verify:abc:1', prompt: 'y', role: 'verifier' })

  const finder = service.specs[0]
  assert.deepEqual(finder.agentOptions, { reasoningEffort: 'high' }, 'finder 走 finderEffort')
  assert.equal(finder.agentPreset, 'review-readonly', 'finder 走 finderPreset')

  const verifier = service.specs[1]
  assert.deepEqual(verifier.agentOptions, { reasoningEffort: 'max' }, '复核者保留高推理强度')
  assert.equal('agentPreset' in verifier, false, '未配置 verifier preset 时不应发送')
})

test('provider 不支持 agentOptions 时继承父代理并只 warn 一次', async () => {
  const parent = { id: 'parent-1' }
  const service = createFakeSubagents({ parent, capabilities: { ...CAPABILITIES, agentOptions: false } })
  const runChild = runnerFor(service, { parentAgent: parent })

  await runChild({ label: 'review:find:correctness', prompt: 'x', role: 'finder' })
  await runChild({ label: 'review:find:lifecycle', prompt: 'y', role: 'finder' })

  assert.equal('agentOptions' in service.specs[0], false, '不支持时不应发送 agentOptions')
  assert.equal('agentOptions' in service.specs[1], false)
  assert.equal(runChild.warnings.length, 1, '同一个 role 只 warn 一次')
  assert.match(runChild.warnings[0], /agentOptions/)
})

test('配置了 preset 但 provider 不支持时在启动前拒绝', () => {
  const parent = { id: 'parent-1' }
  const service = createFakeSubagents({ parent, capabilities: { ...CAPABILITIES, agentPreset: false } })
  const config = { ...DEFAULT_CONFIG, finderPreset: 'review-readonly' }

  assert.throws(() => runnerFor(service, { parentAgent: parent, config }), /不支持 agentPreset/)
  assert.equal(service.specs.length, 0, '拒绝必须发生在任何子代理创建之前')
})

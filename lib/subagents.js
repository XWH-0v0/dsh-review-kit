/**
 * Child-agent runner backed by `ctx.subagents`.
 *
 * One review child = one managed activation with `delivery: 'caller'`: the
 * pipeline awaits the result directly, and the parent conversation is not
 * spammed with one completion notice per fan-out child. A child is always
 * cancelled through its own activation when it exceeds the per-child budget, so
 * a hung finder cannot hold the whole review open.
 *
 * @module dsh-review-kit/subagents
 */

import { textOfContent } from './text.js'

/**
 * Resolve the per-role child route: reasoning effort, optional agent preset and
 * the tool budget the prompt states.
 *
 * Finders are recall-oriented and were measured spending most of their wall
 * clock on exploration planning, so they default below the parent's effort;
 * verifiers are the precision gate and keep the parent's effort. An empty
 * effort or preset means "inherit the calling agent", which is what every child
 * did before this split existed.
 *
 * @param {object} config resolved config.
 * @param {string} [role] `finder`, `verifier`, or anything else for no override.
 * @returns {{effort: string, preset: string, toolBudget: number}} the route.
 */
export function resolveChildRoute(config, role) {
  if (role === 'finder') {
    return { effort: config.finderEffort, preset: config.finderPreset, toolBudget: config.finderToolBudget }
  }
  if (role === 'verifier') {
    return { effort: config.verifierEffort, preset: config.verifierPreset, toolBudget: config.verifierToolBudget }
  }
  return { effort: '', preset: '', toolBudget: 0 }
}

/**
 * Race a promise against a wall clock and the caller's cancellation signal.
 *
 * @param {Promise<unknown>} promise the child activation result.
 * @param {number} ms per-child budget.
 * @param {AbortSignal|undefined} signal caller cancellation.
 * @param {() => Promise<void>} onTimeout cancel the child before rejecting.
 * @returns {Promise<unknown>} the promise's value.
 */
function withTimeout(promise, ms, signal, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      // Settle the timeout before disposing. dispose() cancels the child, and its
      // activation result then resolves with `stopReason: 'aborted'`; when that
      // resolution won the race, a genuine budget timeout was reported as an
      // unexplained abort (a full-depth run lost two lenses that way). Reject
      // first, then cancel best-effort.
      finish(reject, new Error(`子代理超时（${Math.round(ms / 1_000)}s）`))
      void Promise.resolve().then(onTimeout).catch(() => {})
    }, ms)
    timer.unref?.()

    const onAbort = () => finish(reject, new Error('已中断'))
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function finish(settle, value) {
      if (settled) return
      settled = true
      cleanup()
      settle(value)
    }

    if (signal?.aborted) {
      finish(reject, new Error('已中断'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error))
  })
}

/**
 * Build the child runner for one review tool call.
 *
 * @param {object} options runner options.
 * @param {object} options.ctx host plugin context.
 * @param {object} options.config resolved config.
 * @param {{id: string}} options.parentAgent calling agent, used as the child's parent.
 * @param {string} options.cwd child working directory (repository root).
 * @param {AbortSignal} options.signal caller cancellation.
 * @returns {(spec: {label: string, prompt: string, outputSchema?: object}) => Promise<{stopReason: string, structured: unknown, diagnostic?: string, output: string}>} the runner.
 */
export function createRunChild({ ctx, config, parentAgent, cwd, signal }) {
  const service = ctx.get === undefined ? undefined : ctx.get('subagents')
  if (service === undefined) {
    throw new Error('review 需要 subagents 服务：当前 profile 没有组合 @deepseek-ai/dsh-subagent 或一个 provider。')
  }
  const providerName = config.subagentProvider
  const provider = service.getProvider(providerName)
  if (provider === undefined) {
    const available = service.list().join('、') || '（无）'
    throw new Error(`subagent provider「${providerName}」未注册。可用：${available}。可在插件配置里改 subagentProvider。`)
  }
  if (provider.capabilities?.outputSchema !== true) {
    throw new Error(`subagent provider「${providerName}」不支持结构化输出（outputSchema），review 无法校验子代理结论。`)
  }
  const supportsDepth = provider.capabilities?.depthLimit === true
  const supportsOptions = provider.capabilities?.agentOptions === true
  const supportsPreset = provider.capabilities?.agentPreset === true
  // A configured preset is a deliberate restriction (the finder's read-only
  // tool set); silently ignoring it would review with tools the operator did
  // not allow, so an unsupported provider is a configuration error.
  for (const [role, preset] of [['finder', config.finderPreset], ['verifier', config.verifierPreset]]) {
    if (preset.length > 0 && !supportsPreset) {
      throw new Error(`subagent provider「${providerName}」不支持 agentPreset，无法把 ${role} 子代理切到「${preset}」。请清空 finderPreset/verifierPreset 或换一个支持该能力的 provider。`)
    }
  }
  const optionsWarned = new Set()

  return async function runChild({ label, prompt, outputSchema, role }) {
    if (signal?.aborted) throw new Error('已中断')
    const route = resolveChildRoute(config, role)
    // Reasoning effort is an optimisation, not a contract: a provider without
    // `agentOptions` keeps inheriting the parent, and the review stays correct.
    let effort = ''
    if (route.effort.length > 0 && supportsOptions) {
      effort = route.effort
    } else if (route.effort.length > 0 && !supportsOptions && !optionsWarned.has(role)) {
      optionsWarned.add(role)
      ctx.logger?.warn?.(`[review-kit] subagent provider「${providerName}」不支持 agentOptions，${role} 子代理将继承父代理的推理强度（配置值 ${route.effort} 未生效）`)
    }
    // DSH 0.2.2-rc.5 reads these fields from the spec's top level: `parent`
    // (identity-checked against the live agent), `prompt`, `outputSchema` and
    // `maxDepth`. Putting them under a `request` wrapper leaves `spec.parent`
    // undefined, so `startActivation` throws
    // `Cannot read properties of undefined (reading 'id')` before any child is
    // created, and the other two fields would be silently ignored.
    const activation = await service.startActivation({
      provider: providerName,
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent: parentAgent,
      ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(effort.length > 0 ? { agentOptions: { reasoningEffort: effort } } : {}),
      ...(supportsPreset && route.preset.length > 0 ? { agentPreset: route.preset } : {}),
      ...(supportsDepth ? { maxDepth: config.childMaxDepth } : {}),
      signal,
      delivery: 'caller',
    })

    // One disposal per activation: the timeout path starts it early so the child is
    // cancelled immediately, and the runner awaits the same promise before settling.
    // Awaiting teardown keeps the caller's concurrency slot honest: releasing it on
    // settle alone let the limiter admit another child while this one was still alive.
    let disposal
    const stop = () => {
      if (disposal === undefined) {
        disposal = activation.dispose().catch((error) => {
          ctx.logger?.warn?.(`[review-kit] 子代理 teardown 失败：${error instanceof Error ? error.message : String(error)}`)
        })
      }
      return disposal
    }

    try {
      const result = await withTimeout(
        activation.result,
        config.childTimeoutMs,
        signal,
        stop,
      )
      return {
        stopReason: result.stopReason,
        structured: result.structured,
        diagnostic: result.diagnostic,
        output: textOfContent(result.output),
      }
    } finally {
      await stop()
    }
  }
}

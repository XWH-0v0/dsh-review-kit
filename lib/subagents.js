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
      void (async () => {
        try {
          await onTimeout()
        } catch {
          // Cancellation is best effort; the timeout still rejects.
        } finally {
          finish(reject, new Error(`子代理超时（${Math.round(ms / 1_000)}s）`))
        }
      })()
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

  return async function runChild({ label, prompt, outputSchema }) {
    if (signal?.aborted) throw new Error('已中断')
    const activation = await service.startActivation({
      provider: providerName,
      label,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: parentAgent,
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
        ...(outputSchema === undefined ? {} : { outputSchema }),
        ...(supportsDepth ? { maxDepth: config.childMaxDepth } : {}),
      },
      signal,
      delivery: 'caller',
    })

    try {
      const result = await withTimeout(
        activation.result,
        config.childTimeoutMs,
        signal,
        () => activation.dispose().catch(() => {}),
      )
      return {
        stopReason: result.stopReason,
        structured: result.structured,
        diagnostic: result.diagnostic,
        output: textOfContent(result.output),
      }
    } finally {
      void activation.dispose().catch(() => {})
    }
  }
}

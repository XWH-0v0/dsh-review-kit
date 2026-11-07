/**
 * Review Kit — Host half.
 *
 * Registers one model-facing tool (`review`) and one skill (`review-kit`).
 *
 * The tool is deliberately *evidence gated*: finder children may only report
 * defects whose quoted source line exists in the change snapshot, an
 * independent verifier child must fail to refute them, and every omission is
 * reported as a coverage gap. The plugin never modifies the workspace, never
 * writes files, and never performs a git write operation.
 *
 * @module dsh-review-kit
 */

import { resolveConfig } from './config.js'
import { runReview } from './orchestrator.js'
import { OUTPUT_SCHEMA, REVIEW_PARAMETERS, REVIEW_TOOL_NAME } from './schema.js'
import { registerSkill } from './skill.js'
import { createRunChild } from './subagents.js'

/** Bundle row id; must equal the `id` in cordis.patch.yml. */
export const name = 'review-kit'

/** Services required before `apply` runs. */
export const inject = ['tools', 'subagents']

const PLUGIN_VERSION = '0.1.0'

const TOOL_DESCRIPTION = [
  '对一段代码改动做只读评审，返回可直接阅读的 markdown 报告。',
  '',
  '按视角派只读子代理并行找问题；每条发现必须逐字引用改动快照里的真实代码行（引用不存在的行会被拒收），再交独立复核者尝试推翻，只有无法推翻的才上报。报告同时列出覆盖缺口：哪些视角失败、哪些文件没看到、哪些发现被预算裁掉。',
  '',
  '用于完成一次功能或修复后、提交或合并前的自查，或用户要求 review 时。只读：不修改工作区、不执行 git 写操作、不自动修复。',
].join('\n')

/**
 * Resolve the calling session's working directory.
 *
 * The directory owner (`ctx.workingDirectory.ensure`) is authoritative: it
 * validates the current value, restores a missing project, and takes the same
 * cancellation signal as the tool call. Header and process values are only
 * fallbacks for compositions without that service.
 *
 * @param {object} ctx host plugin context.
 * @param {{agent?: object, signal?: AbortSignal}} exec current tool execution.
 * @returns {Promise<string>} absolute directory to start git from.
 */
async function resolveCwd(ctx, exec) {
  const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  const agent = exec?.agent
  if (service !== undefined && service !== null && agent !== undefined && typeof service.ensure === 'function') {
    try {
      const directory = await service.ensure(agent, exec.signal)
      if (typeof directory === 'string' && directory.length > 0) return directory
    } catch {
      // Fall through to the header.
    }
  }
  const session = agent?.session
  const headerDirectory = session?.header?.cwd
  if (typeof headerDirectory === 'string' && headerDirectory.length > 0) return headerDirectory
  return process.cwd()
}

/**
 * Register the plugin.
 *
 * @param {object} ctx host context.
 * @param {unknown} rawConfig loader-row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  ctx.tools.register({
    name: REVIEW_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: REVIEW_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.markdown === 'string' ? value.markdown : JSON.stringify(value),
      }],
    },
    timeoutMs: 1_800_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const current = exec !== undefined && exec !== null ? exec : {}
      const parentAgent = current.agent
      if (parentAgent === undefined) {
        throw new Error('review 需要在会话中调用（exec.agent 缺失）。')
      }
      const cwd = await resolveCwd(ctx, current)
      const runChild = createRunChild({
        ctx,
        config,
        parentAgent,
        cwd,
        signal: current.signal,
      })
      return runReview({
        args: args !== null && typeof args === 'object' ? args : {},
        config,
        runChild,
        cwd,
        signal: current.signal,
        ctx,
        exec: current,
        logger: ctx.logger,
      })
    },
  })

  registerSkill(ctx, config)

  ctx.logger?.info?.(`[review-kit] v${PLUGIN_VERSION} active (provider=${config.subagentProvider}, depth=${config.depth}, lenses=${config.lenses.join('/')})`)
}

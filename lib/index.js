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

import Schema from '@deepseek-ai/schemastery'

import { createReviewClock } from './clock.js'
import { resolveConfig } from './config.js'
import { runReview } from './orchestrator.js'
import { OUTPUT_SCHEMA, REVIEW_PARAMETERS, REVIEW_TOOL_NAME } from './schema.js'
import { registerSkill } from './skill.js'
import { createRunChild } from './subagents.js'

/** Bundle row id; must equal the `id` in cordis.patch.yml. */
export const name = 'review-kit'

/** Services required before `apply` runs. */
export const inject = ['tools', 'subagents']

/**
 * The loader-facing config schema.
 *
 * Every field is declared, even the ones no form shows yet: the loader validates
 * raw row config through this schema, and an undeclared key would be stripped
 * from an existing profile patch. `test/unit/config-schema.test.mjs` asserts the
 * defaults here stay identical to `DEFAULT_CONFIG` in `lib/config.js`.
 */
export const Config = Schema.object({
  subagentProvider: Schema.string().default('spawn').description('子代理 provider 名称（spawn / fork / …）'),
  finderEffort: Schema.union(['', 'off', 'low', 'high', 'max']).default('high').volatile()
    .description('finder 推理强度；空 = 继承父代理'),
  verifierEffort: Schema.union(['', 'off', 'low', 'high', 'max']).default('max').volatile()
    .description('复核推理强度；复核是精度闸门，默认 max'),
  finderPreset: Schema.string().default('').description('finder 的 agentPreset id；空 = 继承父代理'),
  verifierPreset: Schema.string().default('').description('复核的 agentPreset id；空 = 继承父代理'),
  toolBudgetBase: Schema.number().default(0).volatile()
    .description('两个角色共用的期望工具调用基数；0 = 各角色用自己的基数。只改起点，按改动量放大的规则不变'),
  finderToolBudget: Schema.number().default(6).volatile().description('finder 在单文件小改动上的期望工具调用数'),
  finderToolBudgetMax: Schema.number().default(18).volatile().description('finder 期望上限（允许轻微超出）'),
  verifierToolBudget: Schema.number().default(5).volatile().description('单条发现的复核期望工具调用数'),
  verifierToolBudgetMax: Schema.number().default(10).volatile().description('复核期望上限'),
  depth: Schema.union(['quick', 'full']).default('full').description('quick = 2 个视角 / 4 条；full = 4 个视角 / 8 条'),
  lenses: Schema.array(Schema.string()).default([]).description('只跑指定视角；空 = 全部四个'),
  verifiersPerFinding: Schema.number().default(1).description('每条发现的独立复核者数量'),
  maxFindings: Schema.number().default(8).description('进入复核的发现条数上限'),
  maxCandidatesPerLens: Schema.number().default(6).description('单个视角最多返回的候选数（超出会如实上报截断）'),
  maxChildren: Schema.number().default(24).description('估算子代理数的硬上限，超过则降级或拒绝'),
  maxConcurrentChildren: Schema.number().default(8).description('同时运行的子代理数；超过 8 需同时调高 host 的 maxActiveSubagents'),
  childTimeoutMs: Schema.number().default(420_000).volatile().description('单个子代理的超时（毫秒）'),
  softTimeoutMs: Schema.number().default(900_000).description('整轮评审软超时（毫秒），到期返回部分报告'),
  onVerifierFailure: Schema.union(['refute', 'observation']).default('refute')
    .description('复核不可用时：refute = 宁漏不错，observation = 单列为未验证'),
  childMaxDepth: Schema.number().default(1).description('子代理可继续委派的深度'),
  maxFiles: Schema.number().default(40).description('单次评审读取的改动文件上限'),
  maxDiffChars: Schema.number().default(400_000).description('一次评审的改动文本总预算（字符）'),
  perFileDiffChars: Schema.number().default(60_000).description('单个文件的 diff 字符上限'),
  maxFileBytes: Schema.number().default(400_000).description('超过该字节数的文件跳过并上报'),
  maxFullFileChars: Schema.number().default(60_000).description('无 diff 时附全文的字符上限'),
  fullFileMaxChars: Schema.number().default(20_000).description('有 diff 时仍附全文的文件大小上限；更大的只给 diff'),
  gitMode: Schema.union(['auto', 'tool', 'process']).default('auto')
    .description('auto = 走调用方 shell 工具；process = 直接跑只读 git'),
  gitTimeoutMs: Schema.number().default(60_000).description('单条 git 命令的超时（毫秒）'),
  registerSkill: Schema.boolean().default(true).description('是否注册 review-kit 技能'),
})

const PLUGIN_VERSION = '0.3.1'

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
  // Startup values only: the skill switch, static warnings and the activation log.
  // Every tool call re-reads the config instead — see `execute`.
  const startup = resolveConfig(rawConfig)

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
    timeoutMs: 3_600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const current = exec !== undefined && exec !== null ? exec : {}
      const parentAgent = current.agent
      if (parentAgent === undefined) {
        throw new Error('review 需要在会话中调用（exec.agent 缺失）。')
      }
      const cwd = await resolveCwd(ctx, current)
      // Re-read the config for this call. The settings form edits `.volatile()`
      // fields, which the loader replaces in place; a snapshot taken in `apply`
      // would keep serving the values from plugin start.
      const config = resolveConfig(rawConfig)
      // One clock owns the whole review: caller cancellation and the review-level
      // wall clock feed the same signal, so a slow review stops fanning out and
      // settles as a partial report instead of running into the tool hard timeout.
      const clock = createReviewClock(current.signal, config.softTimeoutMs)
      try {
        const runChild = createRunChild({
          ctx,
          config,
          parentAgent,
          cwd,
          signal: clock.signal,
        })
        return await runReview({
          args: args !== null && typeof args === 'object' ? args : {},
          config,
          runChild,
          cwd,
          signal: clock.signal,
          clock,
          ctx,
          exec: current,
          logger: ctx.logger,
        })
      } finally {
        clock.dispose()
      }
    },
  })

  registerSkill(ctx, startup)

  // The subagent runtime's tree capacity defaults to 8 concurrently active
  // children. A higher limiter does not fail here; it fails later with
  // ACTIVATION_LIMIT_REACHED inside each over-cap child, which reads as a lens
  // failure. Warn while the cause is still obvious.
  if (startup.maxConcurrentChildren > 8) {
    ctx.logger?.warn?.(`[review-kit] maxConcurrentChildren=${startup.maxConcurrentChildren} 超过 subagent 默认树容量 8；需同时调高 host 的 maxActiveSubagents，否则超出部分会以 ACTIVATION_LIMIT_REACHED 失败`)
  }

  ctx.logger?.info?.(`[review-kit] v${PLUGIN_VERSION} active (provider=${startup.subagentProvider}, depth=${startup.depth}, lenses=${startup.lenses.join('/')}, effort=${startup.finderEffort || 'inherit'}/${startup.verifierEffort || 'inherit'})`)
}

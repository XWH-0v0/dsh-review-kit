/**
 * Model-facing and executor-facing schemas.
 *
 * Three dialects live in this one file so they cannot drift apart:
 *   1. `REVIEW_PARAMETERS` — the tool's model-facing parameter JSON Schema;
 *   2. `FINDINGS_SCHEMA` / `VERDICT_SCHEMA` — object-rooted JSON Schema handed
 *      to child agents as `outputSchema`;
 *   3. `OUTPUT_SCHEMA` — the tool's canonical output value.
 *
 * The schema vocabulary is limited to the keywords DSH's own JsonSchemaNode
 * declares (type, properties, required, items, enum, const, additionalProperties,
 * description): no `minimum`, `pattern` or `$ref`, which the seam does not
 * promise to honour.
 *
 * @module dsh-review-kit/schema
 */

import { KINDS, LENS_KEYS, SEVERITIES } from './config.js'

/** The model-facing tool name. */
export const REVIEW_TOOL_NAME = 'review'

const STRING = Object.freeze({ type: 'string' })
const STRING_ARRAY = Object.freeze({ type: 'array', items: STRING })

/** @type {Record<string, unknown>} */
export const REVIEW_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      enum: ['uncommitted', 'base', 'commit', 'files'],
      description: '评审范围。uncommitted（默认）：工作区相对 HEAD 的改动，含未跟踪文件；base：相对 base 参数所给基线；commit：某次提交引入的改动；files：files 参数列出的文件当前内容。',
    },
    base: {
      type: 'string',
      description: 'target=base 时的基线引用，例如 origin/main、main、HEAD~3 或提交 sha。target=commit/files 时忽略。',
    },
    commit: {
      type: 'string',
      description: 'target=commit 时必填：要评审的提交 sha。',
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'target=files 时必填：仓库相对路径（正斜杠）。最多 40 个，超出部分记为覆盖缺口。',
    },
    depth: {
      type: 'string',
      enum: ['quick', 'full'],
      description: 'quick：最多 2 个视角、最多复核 4 条，适合小改动；full（默认）：全部视角、最多 12 条。预计子代理数超过上限时会自动降级为 quick。',
    },
    lenses: {
      type: 'array',
      items: { type: 'string', enum: [...LENS_KEYS] },
      description: '只跑指定视角，默认全部四个（correctness、lifecycle、contract、security）。',
    },
    maxFindings: {
      type: 'integer',
      description: '进入复核的发现条数上限，默认 12；越大越贵。',
    },
  },
  required: [],
}

/** Finder output: a bare findings array, no lens (the plugin owns that). */
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'anchor', 'kind', 'title', 'detail', 'failureScenario'],
        properties: {
          file: {
            type: 'string',
            description: '仓库相对路径（正斜杠），必须出现在改动清单里。',
          },
          anchor: {
            type: 'string',
            description: '从该文件当前内容里逐字复制的一整行源码，不要改写缩进/空白，不要带行号。',
          },
          kind: {
            type: 'string',
            enum: [...KINDS],
            description: 'correctness=逻辑错误；state=状态/生命周期；breaking=破坏契约；security=安全。',
          },
          title: { type: 'string', description: '一句话陈述缺陷，不超过 80 字。' },
          detail: { type: 'string', description: '代码在做什么、为什么错，引用具体标识符。' },
          failureScenario: { type: 'string', description: '具体输入/状态 → 具体错误行为。写不出来就不要报。' },
          severity: {
            type: 'string',
            enum: [...SEVERITIES],
            description: 'critical=会丢数据/可被利用；major=功能错误；minor=边界情况。',
          },
          suggestedFix: { type: 'string', description: '可选：最小修复方向，不要贴大段补丁。' },
        },
      },
    },
  },
}

/** Verifier output: an independent adversarial verdict. */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed', 'confidence', 'reasoning'],
  properties: {
    confirmed: {
      type: 'boolean',
      description: '只有在你读了真实代码、且无法推翻该结论时才为 true。',
    },
    confidence: { type: 'number', description: '0 到 1，由你独立给出。' },
    reasoning: {
      type: 'string',
      description: '你读了哪些行/文件，为什么站得住或站不住；能复现就写复现方式。',
    },
    reproduced: { type: 'boolean', description: '是否真的构造出了失败（跑命令或写临时脚本）。' },
    origin: {
      type: 'string',
      enum: ['introduced', 'preexisting', 'unknown'],
      description: '缺陷是本次改动引入的、基线里原本就有的，还是无法判定。',
    },
  },
}

const VERDICT_OUT = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed', 'confidence', 'reasoning'],
  properties: {
    confirmed: { type: 'boolean' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    reproduced: { type: 'boolean' },
    origin: { type: 'string', enum: ['introduced', 'preexisting', 'unknown'] },
  },
}

const FINDING_OUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'file', 'line', 'anchor', 'kind', 'title', 'detail', 'failureScenario',
    'severity', 'lens', 'lenses', 'origin', 'confidence', 'status', 'verifications',
  ],
  properties: {
    id: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    anchor: { type: 'string' },
    kind: { type: 'string', enum: [...KINDS] },
    title: { type: 'string' },
    detail: { type: 'string' },
    failureScenario: { type: 'string' },
    severity: { type: 'string', enum: [...SEVERITIES] },
    lens: { type: 'string' },
    lenses: { type: 'array', items: STRING },
    origin: { type: 'string', enum: ['introduced', 'preexisting', 'unknown'] },
    originHint: { type: 'string', enum: ['possibly-preexisting', 'new', 'unknown'] },
    confidence: { type: 'number' },
    suggestedFix: { type: 'string' },
    status: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
    verifications: { type: 'array', items: VERDICT_OUT },
  },
}

const REJECTED_OUT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'file', 'title', 'severity', 'reason'],
  properties: {
    id: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    anchor: { type: 'string' },
    title: { type: 'string' },
    severity: { type: 'string' },
    lens: { type: 'string' },
    lenses: STRING_ARRAY,
    reason: { type: 'string' },
    confidence: { type: 'number' },
  },
}

const COVERAGE_OUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'target', 'depth', 'lensesRun', 'lensesFailed', 'lensesClean', 'filesReviewed', 'filesSkipped',
    'findingsFound', 'findingsInvalid', 'findingsDeduped', 'findingsDropped', 'verifiersRun',
    'verifiersFailed', 'aborted', 'truncated', 'durationMs', 'childRuns', 'notes',
  ],
  properties: {
    target: { type: 'string' },
    baseRef: { type: 'string' },
    depth: { type: 'string' },
    lensesRun: STRING_ARRAY,
    lensesFailed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lens', 'reason'],
        properties: { lens: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    lensesClean: STRING_ARRAY,
    filesReviewed: STRING_ARRAY,
    filesSkipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'reason'],
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    findingsFound: { type: 'integer' },
    findingsInvalid: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'title', 'reason'],
        properties: { file: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    findingsDeduped: { type: 'integer' },
    findingsDropped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'title', 'reason'],
        properties: { file: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    verifiersRun: { type: 'integer' },
    verifiersFailed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    aborted: { type: 'boolean' },
    truncated: { type: 'boolean' },
    durationMs: { type: 'integer' },
    childRuns: { type: 'integer' },
    notes: STRING_ARRAY,
  },
}

/** The canonical tool output value. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'status', 'markdown', 'confirmed', 'refuted', 'unverified', 'coverage', 'stats'],
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string', enum: ['completed', 'partial', 'aborted', 'failed'] },
    markdown: { type: 'string' },
    confirmed: { type: 'array', items: FINDING_OUT },
    refuted: { type: 'array', items: REJECTED_OUT },
    unverified: { type: 'array', items: REJECTED_OUT },
    coverage: COVERAGE_OUT,
    stats: {
      type: 'object',
      additionalProperties: false,
      required: ['candidates', 'valid', 'invalid', 'deduped', 'dropped', 'verified', 'confirmed', 'refuted', 'unverified'],
      properties: {
        candidates: { type: 'integer' },
        valid: { type: 'integer' },
        invalid: { type: 'integer' },
        deduped: { type: 'integer' },
        dropped: { type: 'integer' },
        verified: { type: 'integer' },
        confirmed: { type: 'integer' },
        refuted: { type: 'integer' },
        unverified: { type: 'integer' },
      },
    },
  },
}

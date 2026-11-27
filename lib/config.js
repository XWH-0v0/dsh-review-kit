/**
 * Review Kit — configuration defaults and normalizers.
 *
 * The bundle exports no `Config` schema: like other small Harness plugins we
 * merge the loader row's raw `config` over these defaults and validate each
 * field defensively. That keeps the package free of `@deepseek-ai/*` imports,
 * which a linked workspace bundle cannot resolve.
 *
 * @module dsh-review-kit/config
 */

/** The four review lenses, in report order. */
export const LENS_KEYS = Object.freeze(['correctness', 'lifecycle', 'contract', 'security'])

/** Accepted finding kinds. Everything else (style, naming, nitpick…) is rejected at the gate. */
export const KINDS = Object.freeze(['correctness', 'state', 'breaking', 'security'])

/** Finding severities, most severe first. */
export const SEVERITIES = Object.freeze(['critical', 'major', 'minor'])

/** Sort rank: lower is more severe. */
export const SEVERITY_RANK = Object.freeze({ critical: 0, major: 1, minor: 2 })

/**
 * Reasoning efforts a child may be given. An empty string means "inherit the
 * calling agent", which is what every child did before 0.2.0.
 */
export const EFFORTS = Object.freeze(['', 'off', 'low', 'high', 'max'])

/** Severity marker used by the markdown report. */
export const SEVERITY_ICON = Object.freeze({ critical: '🔴', major: '🟡', minor: '🔵' })

/** Extensions that never participate in code review (pitfall #8 in the design doc). */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.text', '.rst', '.adoc'])

/** Defaults for every tunable. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Registered `ctx.subagents` provider used for finder and verifier children. */
  subagentProvider: 'spawn',
  /**
   * Reasoning effort for finder children. Measured runs showed finders burning
   * 18k-43k characters of reasoning per step on exploration planning, so the
   * recall-oriented finders run below the parent's `max`; the verifiers keep
   * their effort, because they are the precision gate.
   */
  finderEffort: 'high',
  /** Reasoning effort for verifier children. */
  verifierEffort: 'max',
  /** Optional `agentPreset` id for finders (spawn provider only); empty inherits the parent. */
  finderPreset: '',
  /** Optional `agentPreset` id for verifiers; empty inherits the parent. */
  verifierPreset: '',
  /**
   * Shared base for the expected tool-call budget of both child roles. `0`
   * leaves each role on its own base (`finderToolBudget` / `verifierToolBudget`),
   * which is what the defaults do. Set a positive number to set one base for
   * both roles without changing the size-driven scaling on top of it.
   */
  toolBudgetBase: 0,
  /**
   * Expected finder tool calls for a small, single-file change. The prompt
   * states this as an expectation, not a hard cap; see `expectedToolBudget`.
   */
  finderToolBudget: 6,
  /** Upper expectation for a big finder scope; a slight overrun is tolerated. */
  finderToolBudgetMax: 18,
  /** Expected verifier tool calls for one finding. */
  verifierToolBudget: 5,
  /** Upper expectation for one verifier; a slight overrun is tolerated. */
  verifierToolBudgetMax: 10,
  /** `full` runs every lens; `quick` caps lenses and verified findings. */
  depth: 'full',
  /** Default lens subset; empty means all four. */
  lenses: [],
  /** Independent adversarial verifiers per finding (all must confirm). */
  verifiersPerFinding: 1,
  /** Maximum findings that reach verification. */
  maxFindings: 8,
  /** Maximum candidates one finder may return (truncated, not punished). */
  maxCandidatesPerLens: 6,
  /** Upper bound on estimated child agents before the run is refused. */
  maxChildren: 24,
  /**
   * Simultaneous child agents. The subagent runtime's own tree capacity
   * (`maxActiveSubagents`) defaults to 8, so exceeding this refuses new
   * activations; the default sits right at that ceiling.
   */
  maxConcurrentChildren: 8,
  /** Per-child wall clock (finder or verifier). */
  childTimeoutMs: 300_000,
  /** Whole-review wall clock: on expiry the run cancels its children and returns a partial report. */
  softTimeoutMs: 900_000,
  /** `refute` (default) or `observation` when a verifier is unavailable. */
  onVerifierFailure: 'refute',
  /** Delegation-depth cap sent to each child (`1` allows the child, forbids grandchildren). */
  childMaxDepth: 1,
  /** Maximum changed files read for one review. */
  maxFiles: 40,
  /** Total diff characters included in a finder prompt. */
  maxDiffChars: 400_000,
  /** Diff characters included per file. */
  perFileDiffChars: 60_000,
  /** Files larger than this (bytes) are skipped and reported. */
  maxFileBytes: 400_000,
  /** Full-file characters included when a file has no diff. */
  maxFullFileChars: 60_000,
  /**
   * Largest file body still quoted in full next to its diff. Bigger files get
   * the diff only (the prompt tells the child to read what it needs), which
   * keeps one review from spending its whole text budget on duplicate content.
   */
  fullFileMaxChars: 20_000,
  /** `auto` prefers the calling agent's shell tool; `process` runs git directly. */
  gitMode: 'auto',
  /** Per-git-command timeout. */
  gitTimeoutMs: 60_000,
  /** Register the `review-kit` skill when the skills service is present. */
  registerSkill: true,
})

/**
 * Whether a repository path is documentation-only.
 *
 * @param {string} path repository-relative path.
 * @returns {boolean} true when the file never triggers code review.
 */
export function isDocPath(path) {
  const lower = String(path ?? '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return false
  return DOC_EXTENSIONS.has(lower.slice(dot))
}

/**
 * @param {unknown} value candidate number.
 * @param {number} fallback value when the candidate is not a usable integer.
 * @param {number} min inclusive lower bound.
 * @param {number} max inclusive upper bound.
 * @returns {number} a bounded integer.
 */
function boundedInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * @param {unknown} value candidate string.
 * @param {readonly string[]} allowed accepted values.
 * @param {string} fallback value when the candidate is not allowed.
 * @returns {string} one allowed value.
 */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * @param {unknown} value candidate reasoning effort.
 * @param {string} fallback value when the candidate is not allowed.
 * @returns {string} one allowed effort id, or `''` for "inherit the parent".
 */
function effortOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const lower = value.trim().toLowerCase()
  return EFFORTS.includes(lower) ? lower : fallback
}

/**
 * @param {unknown} value candidate preset id.
 * @param {string} fallback value when the candidate is not a string.
 * @returns {string} a trimmed preset id, or `''` for "inherit the parent".
 */
function presetOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  return value.trim()
}

/**
 * Normalize a lens selection: keep known keys, drop duplicates, preserve
 * canonical order. An empty or non-array input means "all lenses".
 *
 * @param {unknown} value raw configured or requested lenses.
 * @returns {string[]} canonical lens keys.
 */
export function normalizeLenses(value) {
  if (!Array.isArray(value)) return [...LENS_KEYS]
  const wanted = new Set(
    value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => LENS_KEYS.includes(item)),
  )
  const kept = LENS_KEYS.filter((key) => wanted.has(key))
  return kept.length > 0 ? kept : [...LENS_KEYS]
}

/**
 * Merge a loader row's raw config over the defaults.
 *
 * @param {unknown} raw loader-row config.
 * @returns {typeof DEFAULT_CONFIG} a complete, validated config.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const provider = typeof input.subagentProvider === 'string' && input.subagentProvider.trim().length > 0
    ? input.subagentProvider.trim()
    : DEFAULT_CONFIG.subagentProvider
  const depth = oneOf(input.depth, ['quick', 'full'], DEFAULT_CONFIG.depth)
  const onVerifierFailure = oneOf(input.onVerifierFailure, ['refute', 'observation'], DEFAULT_CONFIG.onVerifierFailure)
  const gitMode = oneOf(input.gitMode, ['auto', 'tool', 'process'], DEFAULT_CONFIG.gitMode)
  const childMaxDepth = input.childMaxDepth === undefined
    ? DEFAULT_CONFIG.childMaxDepth
    : boundedInt(input.childMaxDepth, DEFAULT_CONFIG.childMaxDepth, 0, 8)
  const finderToolBudget = boundedInt(input.finderToolBudget, DEFAULT_CONFIG.finderToolBudget, 0, 50)
  const verifierToolBudget = boundedInt(input.verifierToolBudget, DEFAULT_CONFIG.verifierToolBudget, 0, 50)

  return {
    subagentProvider: provider,
    finderEffort: effortOr(input.finderEffort, DEFAULT_CONFIG.finderEffort),
    verifierEffort: effortOr(input.verifierEffort, DEFAULT_CONFIG.verifierEffort),
    finderPreset: presetOr(input.finderPreset, DEFAULT_CONFIG.finderPreset),
    verifierPreset: presetOr(input.verifierPreset, DEFAULT_CONFIG.verifierPreset),
    // A positive shared base replaces both role bases below; 0 means "use the
    // role bases". The size-driven scaling on top is unaffected either way.
    toolBudgetBase: boundedInt(input.toolBudgetBase, DEFAULT_CONFIG.toolBudgetBase, 0, 50),
    finderToolBudget,
    // The ceiling is clamped up to the base so a mis-ordered pair can never
    // produce an expectation below its own starting value.
    finderToolBudgetMax: Math.max(
      finderToolBudget,
      boundedInt(input.finderToolBudgetMax, DEFAULT_CONFIG.finderToolBudgetMax, 0, 80),
    ),
    verifierToolBudget,
    verifierToolBudgetMax: Math.max(
      verifierToolBudget,
      boundedInt(input.verifierToolBudgetMax, DEFAULT_CONFIG.verifierToolBudgetMax, 0, 80),
    ),
    depth,
    lenses: normalizeLenses(input.lenses),
    verifiersPerFinding: boundedInt(input.verifiersPerFinding, DEFAULT_CONFIG.verifiersPerFinding, 1, 3),
    maxFindings: boundedInt(input.maxFindings, DEFAULT_CONFIG.maxFindings, 1, 60),
    maxCandidatesPerLens: boundedInt(input.maxCandidatesPerLens, DEFAULT_CONFIG.maxCandidatesPerLens, 1, 20),
    maxChildren: boundedInt(input.maxChildren, DEFAULT_CONFIG.maxChildren, 1, 64),
    maxConcurrentChildren: boundedInt(input.maxConcurrentChildren, DEFAULT_CONFIG.maxConcurrentChildren, 1, 16),
    childTimeoutMs: boundedInt(input.childTimeoutMs, DEFAULT_CONFIG.childTimeoutMs, 10_000, 3_600_000),
    softTimeoutMs: boundedInt(input.softTimeoutMs, DEFAULT_CONFIG.softTimeoutMs, 30_000, 3_000_000),
    onVerifierFailure,
    childMaxDepth,
    maxFiles: boundedInt(input.maxFiles, DEFAULT_CONFIG.maxFiles, 1, 200),
    maxDiffChars: boundedInt(input.maxDiffChars, DEFAULT_CONFIG.maxDiffChars, 20_000, 2_000_000),
    perFileDiffChars: boundedInt(input.perFileDiffChars, DEFAULT_CONFIG.perFileDiffChars, 2_000, 500_000),
    maxFileBytes: boundedInt(input.maxFileBytes, DEFAULT_CONFIG.maxFileBytes, 10_000, 4_000_000),
    maxFullFileChars: boundedInt(input.maxFullFileChars, DEFAULT_CONFIG.maxFullFileChars, 2_000, 500_000),
    fullFileMaxChars: boundedInt(input.fullFileMaxChars, DEFAULT_CONFIG.fullFileMaxChars, 2_000, 200_000),
    gitMode,
    gitTimeoutMs: boundedInt(input.gitTimeoutMs, DEFAULT_CONFIG.gitTimeoutMs, 5_000, 600_000),
    registerSkill: input.registerSkill === undefined ? DEFAULT_CONFIG.registerSkill : input.registerSkill === true,
  }
}

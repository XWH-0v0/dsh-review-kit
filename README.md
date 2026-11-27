# dsh-review-kit

<p align="center">
  <img src="icon.svg" width="72" height="72" alt="dsh-review-kit icon">
</p>

<p align="center">
  <b>A code review plugin for DeepSeek Harness that refuses to report what it cannot prove.</b>
</p>

<p align="center">
  <sub><b>by DeepSeek</b> · built on <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a></sub>
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a>
</p>

<p align="center">
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4D6BFE">
  <img alt="by DeepSeek" src="https://img.shields.io/badge/by-DeepSeek-1D4ED8">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-339933">
  <img alt="Tests" src="https://img.shields.io/badge/tests-80%20unit%20%2B%2011%20e2e-2ea44f">
  <img alt="Read-only" src="https://img.shields.io/badge/read--only-yes-6b7280">
</p>

---

<a id="english"></a>

## English

### What it is

`dsh-review-kit` is a read-only, **evidence-gated** code review plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers one
model-facing tool (`review`) and one on-demand skill (`review-kit`).

Most "multi-agent code review" plugins ask several agents to list problems and then
print whatever they said. This one is built around the opposite idea: a finding only
reaches the report if it can be **proven against the actual change snapshot** and
**survives an independent attempt to refute it**.

### Why this one

| # | Mechanism | What it does |
|---|---|---|
| 1 | **Verbatim anchors** | Every finding must quote one real line from the change snapshot. The plugin locates the line itself; a quote that does not exist is rejected as *invalid output*, never counted as a false positive. |
| 2 | **Adversarial verification** | Each surviving finding gets an independent verifier whose job is to **refute** it. The verifier never sees the finder's lens or reasoning — only the code and the claimed failure. Unverifiable means not confirmed. |
| 3 | **Origin attribution** | Verifiers classify `introduced` / `preexisting` / `unknown`. A baseline line match is only a hint, never a verdict. |
| 4 | **Transparent coverage** | The report always states which lenses ran, which failed, which files were skipped, which findings the budget dropped, and how many children ran. A clean run reports its scope instead of just saying "no issues". |

Also included: a kind whitelist (`correctness | state | breaking | security`),
fingerprint deduplication, a severity-ordered budget with automatic `quick`
degradation, one shared concurrency limiter, and full cancellation propagation.

### Requirements

- DeepSeek Harness `0.2.2-rc.1` (desktop profile tested), Node `>= 22`
- The `subagents` service with a provider that supports structured output
  (`spawn` qualifies) — the plugin refuses to run rather than silently degrade
- Git for the `uncommitted` / `base` / `commit` scopes (`files` works without it)

### Install

Install the directory as a bundle in a Harness profile:

```text
plugin_manager(action: "install_bundle", target: "<abs path>/dsh-review-kit")
```

The bundle row is declared in [`cordis.patch.yml`](cordis.patch.yml). There is no
build step and no `@deepseek-ai/*` import: the package is plain ESM plus Node
builtins, so it works as a linked workspace bundle.

To pin configuration, override the row in the profile:

```yaml
- id: review-kit
  name: '@local/dsh-review-kit'
  config:
    depth: quick
    maxConcurrentChildren: 4
```

### Usage

Ask in plain language — "review this change" — or call the tool:

```jsonc
{ "target": "uncommitted" }                                  // default: worktree vs HEAD
{ "target": "base", "base": "origin/main" }                  // vs a baseline ref
{ "target": "commit", "commit": "<sha>" }                    // the change one commit introduced
{ "target": "files", "files": ["src/a.ts", "src/b.ts"] }     // explicit files
{ "depth": "quick" }                                         // <= 2 lenses, <= 4 verified
{ "lenses": ["security"], "maxFindings": 4 }                 // narrow scope
```

The model receives a markdown report; the canonical value keeps structured
`confirmed` / `refuted` / `unverified` arrays plus `coverage` and `stats` for
programmatic callers.

A live run against a one-file fixture with `lenses: ["correctness"], depth: "quick"`
took **1m19s and 2 children**: one finder reported a missing-key `TypeError`, the
verifier reproduced it with a throwaway script outside the repo (confidence
`0.96`, origin `introduced`).

### Read the report

1. **Confirmed** — `file:line`, the verbatim quoted line, the failure scenario, the
   verifier's conclusion and confidence, and the origin. These are the ones to fix.
2. **Refuted** — collapsed; the verifier's counter-evidence. Do not report these as
   problems.
3. **Unverified** — the verifier was unavailable. Not confirmed.
4. **Coverage / skipped / stats** — the honest part. `✅ ran, nothing found` is not
   the same as `⚠️ failed`. A review with coverage gaps must be reported as such.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Registered `ctx.subagents` provider |
| `finderEffort` | `high` | Child reasoning effort for finders; `''` inherits the parent |
| `verifierEffort` | `max` | Child reasoning effort for verifiers; `''` inherits the parent |
| `finderPreset` | `''` | Optional `agentPreset` id for finders (`''` inherits); hard tool restriction |
| `verifierPreset` | `''` | Optional `agentPreset` id for verifiers (`''` inherits) |
| `toolBudgetBase` | `0` | Shared base for both roles' expected tool calls; `0` = each role uses its own base below. The size-driven scaling is unchanged |
| `finderToolBudget` | `6` | Expected finder tool calls for a small change (scales with files and change size) |
| `finderToolBudgetMax` | `18` | Upper expectation for a big finder scope; a slight overrun is allowed |
| `verifierToolBudget` | `5` | Expected verifier tool calls for one finding |
| `verifierToolBudgetMax` | `10` | Upper expectation for one verifier |
| `depth` | `full` | `full` or `quick` |
| `lenses` | `[]` | `[]` = all four (`correctness`, `lifecycle`, `contract`, `security`) |
| `verifiersPerFinding` | `1` | 1–3; all must confirm |
| `maxFindings` | `8` | Findings that reach verification |
| `maxCandidatesPerLens` | `6` | Truncation only, not a failure |
| `maxChildren` | `24` | Estimate = lenses + findings × verifiers |
| `maxConcurrentChildren` | `8` | Shared limiter; the subagent runtime's own tree capacity defaults to 8 |
| `childTimeoutMs` | `300000` | Per finder/verifier child |
| `softTimeoutMs` | `900000` | Whole review; on expiry children are cancelled and a partial report is returned |
| `onVerifierFailure` | `refute` | `refute` (fail closed) or `observation` |
| `childMaxDepth` | `1` | `1` = children exist but cannot delegate further |
| `maxFiles` | `40` | Changed files read per review |
| `maxDiffChars` | `400000` | Prompt text budget |
| `fullFileMaxChars` | `20000` | Files up to this size are quoted in full next to their diff |
| `gitMode` | `auto` | `auto` / `tool` / `process` |

`gitMode: auto` runs git through the **calling agent's shell tool**
(`ctx.tools.execute`), so the deployment's permissions, sandbox and audit path stay
in charge. `process` runs `git` directly, read-only plumbing only.

#### Child route (0.2.0)

A review's wall clock belongs to its child agents, not to this plugin. Measured on
real runs before 0.2.0: a `quick` review with two lenses spent 790 s in the finder
phase — one finder made **68 tool calls** (running the repository test suite twice,
hunting for a `node` binary, listing `node_modules`) and 52 model steps at the
parent's `max` reasoning effort, while the evidence it needed was already in its
prompt. Reviews took 5–23 minutes.

0.2.0 changes the shape of the work, not the evidence rules:

- both prompts state an **expected** tool budget — 6 calls for a one-file change,
  scaling to 18 as the changed-file count and change text grow, with a slight
  overrun explicitly allowed — and forbid the test suite, dependency installs and
  directory walks. The base is yours to set: `toolBudgetBase` moves both roles to
  one shared base, `finderToolBudget` / `verifierToolBudget` move them separately;
  only the starting point moves, the size-driven scaling stays;
- finders run at `finderEffort: high`; verifiers keep `max`, because the verifier
  is the precision gate and finders are expected to over-generate;
- every lens-independent prompt section comes first, so the four finders share one
  cacheable prefix;
- files larger than `fullFileMaxChars` are quoted as a diff only (the prompt says
  how to read the rest);
- `maxFindings` 12 → 8, `maxCandidatesPerLens` 8 → 6, `childTimeoutMs` 15 → 5 min,
  `softTimeoutMs` 30 → 15 min.

Hard tool restriction is opt-in. A prompt states the budget; only a preset can
enforce it. Declare one in your profile and point `finderPreset` at it:

```yaml
- insert:
    - id: preset-review-readonly
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review-readonly
        name: Review (read-only)
        description: Read-only file inspection for review finders.
        order: 40
        plugins:
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              write: false
              edit: false
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
```

`agentOptions`/`agentPreset` need a provider that declares those capabilities;
`spawn` does. A configured preset that the provider cannot honour is a
configuration error, raised before any child starts.

The plugin is **read-only**: no workspace writes, no report files, no
`git add/commit/stash/restore/worktree`. The only writes anywhere happen inside a
finder/verifier child's own temporary directory when it reproduces a bug.

### Architecture

```
lib/index.js        apply(): register `review` + the `review-kit` skill
lib/orchestrator.js target -> snapshot -> budget -> find -> gate -> dedupe -> cap -> verify -> render
lib/config.js       defaults, lens/kind/severity vocabularies, doc-file policy
lib/target.js       scope parsing + path-escape rejection
lib/git.js          read-only git through the caller's shell tool (or a process fallback)
lib/snapshot.js     before/after/diff per file, binary/large/doc skips, changed-line ranges
lib/lenses.js       four orthogonal lenses (constraints, not personas)
lib/prompt.js       finder + verifier prompts, prompt-budgeted file blocks
lib/schema.js       parameter schema, finder/verifier output schemas, tool output schema
lib/gate.js         kind whitelist + anchor existence + line resolution
lib/fingerprint.js  sha256(kind, path, normalised anchor)[0:16]
lib/dedupe.js       fingerprint merge + conservative near-duplicate merge
lib/budget.js       child-count estimate, quick degradation, refusal
lib/concurrency.js  shared FIFO limiter
lib/dispatch.js     one finder child per lens; a lens failure loses only that lens
lib/verify.js       independent verifiers; policy-driven failure handling
lib/render.js       markdown report
lib/subagents.js    managed activations via ctx.subagents (`delivery: 'caller'`)
lib/skill.js        on-demand skill provider (rank 550)
```

### Tests

```bash
# 80 unit tests (pure modules, a real temporary git repository, the
# activation-spec contract test in test/unit/subagents.test.mjs, and the
# prompt-shape/child-route tests)
node --test test/unit/*.test.mjs

# scripted end-to-end: real snapshot/gate/dedupe/verify/render path, fake children
node test/e2e/run.mjs
```

The e2e harness runs the fixture project at `test/fixtures/buggy-project`
(3 seeded bugs, 2 decoys) and proves:

- a fabricated anchor and a `style` kind are rejected as invalid output (2 of 5 candidates),
- the two real bugs are confirmed and the `<=` pagination finding is refuted,
- every confirmed line number points at the exact quoted source line,
- a clean run still reports coverage, an aborted run returns a schema-valid partial result,
- a lens returning more candidates than the per-lens ceiling is reported as a coverage note,
- a documentation-only scope is refused.

### Runtime notes

The plugin follows the installed Harness runtime rather than older plugin sources:

1. **Subagent API** — `ctx.subagents.startActivation({ provider, label, prompt,
   parent, cwd, outputSchema, maxDepth, signal, delivery: 'caller' })`. The spec is
   flat (`SubagentActivationSpec`, no `request` wrapper): `startActivation` reads
   `parent`, `prompt`, `outputSchema` and `maxDepth` from the top level. Wrapper-shaped
   arguments make it read `spec.parent.id` on `undefined` and throw before any child
   starts, while `outputSchema`/`maxDepth` are silently dropped. The plugin awaits
   `activation.result` and disposes on timeout; `delivery: 'caller'` keeps one
   completion notice per child out of the parent conversation.
2. **`maxDepth` semantics** — the spec's `maxDepth` is the absolute delegation depth
   cap for the child, so `0` refuses to create the child at all. The default is `1`.
3. **Schema dialect** — `parameters` and `output.schema` use ordinary JSON Schema
   with `required: [...]` arrays; subagent `outputSchema` is standard JSON Schema too.
4. **Timeouts** — two levels. `childTimeoutMs` bounds one finder/verifier;
   `softTimeoutMs` bounds the whole review. When the review clock expires the same
   signal cancels in-flight children, queued children never start, and the tool
   returns a partial report with a coverage note. The tool's hard `timeoutMs`
   (60 min) is only a backstop.

### Not included yet

Settings page, `/review*` slash commands, persisted reports, CI blocking,
heterogeneous child models, and a measured false-positive baseline. The tool never
auto-fixes code.

### Attribution

Built **by DeepSeek** with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
The four mechanisms were inspired by publicly documented, MIT-licensed review
plugins; no source code was copied.

---

<a id="中文"></a>

## 中文

### 这是什么

`dsh-review-kit` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的只读、**证据门禁型**代码评审插件。它注册一个模型工具（`review`）和一个按需加载的技能（`review-kit`）。

市面上多数「多智能体评审」插件是让几个 agent 各列一遍问题,然后把说过的话原样打印出来。
这个插件的出发点相反:一条发现只有**在真实改动快照里能逐字对上**、并且**扛住一次独立复核的推翻尝试**,
才会进入报告。

### 差异点

| # | 机制 | 作用 |
|---|---|---|
| 1 | **引用可校验** | 每条发现必须逐字引用快照里真实存在的一行。插件自己反查行号;引用的行不存在时记为「无效输出」,而不是误报。 |
| 2 | **对抗复核** | 每条存活发现都派一个独立复核者,任务就是推翻它。复核者看不到 finder 的视角和推理,只能自己读代码。复核不成立 = 不算确认。 |
| 3 | **归属区分** | 复核者判定 `introduced` / `preexisting` / `unknown`。基线里有同形行只是提示,不是结论。 |
| 4 | **覆盖透明** | 报告必然写明:哪些视角跑了、哪些失败、哪些文件被跳过、哪些发现被预算裁掉、用了多少子代理。干净结果也要说清范围,而不是一句「没问题」。 |

另外还有:kind 白名单(`correctness | state | breaking | security`)、指纹去重、
按严重度消耗的预算与 quick 自动降级、共享并发 limiter、全链路取消透传。

### 前置条件

- DeepSeek Harness `0.2.2-rc.1`(desktop profile 实测),Node `>= 22`
- `subagents` 服务,且 provider 支持结构化输出(`spawn` 满足);不满足时插件直接报错,不会静默降级
- `uncommitted` / `base` / `commit` 范围需要 git(`files` 不需要)

### 安装

把目录作为 bundle 装进 Harness profile:

```text
plugin_manager(action: "install_bundle", target: "<绝对路径>/dsh-review-kit")
```

bundle 行声明在 [`cordis.patch.yml`](cordis.patch.yml)。没有构建步骤,也不 import
`@deepseek-ai/*`:整个包是纯 ESM + Node 内置模块,作为链接式工作区 bundle 直接用。

要固定配置,在 profile 里覆盖该行:

```yaml
- id: review-kit
  name: '@local/dsh-review-kit'
  config:
    depth: quick
    maxConcurrentChildren: 4
```

### 用法

用自然语言说「审一下这次改动」即可,或直接调工具:

```jsonc
{ "target": "uncommitted" }                                  // 默认:工作区 vs HEAD
{ "target": "base", "base": "origin/main" }                  // 相对某个基线
{ "target": "commit", "commit": "<sha>" }                    // 某次提交引入的改动
{ "target": "files", "files": ["src/a.ts", "src/b.ts"] }     // 指定文件
{ "depth": "quick" }                                         // <= 2 个视角,<= 4 条复核
{ "lenses": ["security"], "maxFindings": 4 }                 // 收窄范围
```

模型拿到 markdown 报告;规范结果里另有结构化的 `confirmed` / `refuted` /
`unverified` 数组与 `coverage`、`stats`,方便程序化调用。

实测:对一个单文件 fixture 用 `lenses: ["correctness"], depth: "quick"`,
**1m19s、2 个子代理** —— finder 报出缺失键 `TypeError`,复核者在仓库外写临时脚本复现,
置信度 `0.96`,归属 `introduced`。

### 怎么读报告

1. **确认项** —— `文件:行`、逐字引用的源码行、失败场景、复核结论与置信度、归属。这些才是要修的。
2. **被推翻** —— 折叠显示,附带复核者的反证。不要把这里的东西当成问题汇报。
3. **未验证** —— 复核者不可用。不等于已确认。
4. **覆盖 / 跳过 / 统计** —— 最诚实的一段。`✅ 已跑,无发现` 和 `⚠️ 失败` 是两回事;
   有覆盖缺口就必须如实说明。

### 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 已注册的 `ctx.subagents` provider |
| `finderEffort` | `high` | finder 子代理的推理强度;`''` = 继承父代理 |
| `verifierEffort` | `max` | 复核子代理的推理强度;`''` = 继承父代理 |
| `finderPreset` | `''` | finder 可选的 `agentPreset` id(`''` 继承);用于硬性限制工具 |
| `verifierPreset` | `''` | 复核可选的 `agentPreset` id(`''` 继承) |
| `toolBudgetBase` | `0` | 两个角色共用的期望工具调用基数;`0` = 各角色用自己的基数(见下两行)。按改动量放大的规则不变 |
| `finderToolBudget` | `6` | finder 小改动的期望工具调用数(随文件数与改动量放大) |
| `finderToolBudgetMax` | `18` | 大范围改动的期望上限;允许轻微超出 |
| `verifierToolBudget` | `5` | 单条发现的复核期望工具调用数 |
| `verifierToolBudgetMax` | `10` | 单个复核的期望上限 |
| `depth` | `full` | `full` 或 `quick` |
| `lenses` | `[]` | `[]` = 全部四个(`correctness`、`lifecycle`、`contract`、`security`) |
| `verifiersPerFinding` | `1` | 1–3;全部确认才算通过 |
| `maxFindings` | `8` | 进入复核的条数上限 |
| `maxCandidatesPerLens` | `6` | 只做截断,不算失败 |
| `maxChildren` | `24` | 估算 = 视角数 + 发现数 × 复核数 |
| `maxConcurrentChildren` | `8` | 共享并发上限;subagent 运行时自身的树容量默认也是 8 |
| `childTimeoutMs` | `300000` | 单个 finder/verifier |
| `softTimeoutMs` | `900000` | 整轮评审;到期取消子代理并返回部分结果 |
| `onVerifierFailure` | `refute` | `refute`(宁漏不错)或 `observation` |
| `childMaxDepth` | `1` | `1` = 子代理存在,但不能继续委派 |
| `maxFiles` | `40` | 单次读取的改动文件上限 |
| `maxDiffChars` | `400000` | 提示词文本预算 |
| `fullFileMaxChars` | `20000` | 不超过这个长度的文件在 diff 之外再附全文 |
| `gitMode` | `auto` | `auto` / `tool` / `process` |

`gitMode: auto` 会让 git 走**调用方 agent 的 shell 工具**(`ctx.tools.execute`),
从而保留部署的权限、沙箱与审计链路;`process` 直接跑 git,但只跑只读命令。

#### 子代理路由(0.2.0)

一次评审的耗时属于子代理,不属于这个插件。0.2.0 之前的实测:一次 `quick` 评审
光 finder 阶段就花了 790 秒——其中一个 finder 做了 **68 次工具调用**(把仓库测试套件
跑了两遍、满盘找 `node`、列 `node_modules`)和 52 个模型步,而它需要的证据本来就
在提示词里。评审整体耗时 5–23 分钟。

0.2.0 改的是工作形状,不是证据规则:

- 两个提示词都给出**期望**工具调用数——单文件小改动约 6 次,随改动文件数与改动文本放大到最多 18 次,并明确允许轻微超出——同时禁止跑测试套件、装依赖、翻目录;基数可以自己定:`toolBudgetBase` 让两个角色共用一个基数,`finderToolBudget` / `verifierToolBudget` 分别设;改的只是起点,按改动量放大的规则不变;
- finder 用 `finderEffort: high`;复核保持 `max`——复核是精度闸门,finder 本来就负责多报;
- 所有与视角无关的提示词段落放在最前面,四个 finder 共用一个可缓存的提示词前缀;
- 超过 `fullFileMaxChars` 的文件只给 diff(提示词会说明如何读其余部分);
- `maxFindings` 12 → 8、`maxCandidatesPerLens` 8 → 6、`childTimeoutMs` 15 → 5 分钟、
  `softTimeoutMs` 30 → 15 分钟。

硬性工具限制是可选项:提示词只写预算,**只有 preset 能真正禁用工具**。在 profile 里声明
一个只读 preset,再把 `finderPreset` 指向它:

```yaml
- insert:
    - id: preset-review-readonly
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review-readonly
        name: Review (read-only)
        description: 只读文件查看,供 review finder 使用。
        order: 40
        plugins:
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              write: false
              edit: false
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
```

`agentOptions`/`agentPreset` 需要 provider 声明对应能力;`spawn` 具备。若配置了 preset
而 provider 不支持,会在任何子代理启动前直接报错。

插件是**只读**的:不写工作区、不落盘报告、不执行 `git add/commit/stash/restore/worktree`。
唯一的写操作发生在 finder/verifier 子代理为了复现问题、在它们自己的临时目录里建脚本时。

### 结构

```
lib/index.js        apply():注册 `review` 工具 + `review-kit` 技能
lib/orchestrator.js 目标 -> 快照 -> 预算 -> 找 -> 门禁 -> 去重 -> 截断 -> 复核 -> 渲染
lib/config.js       默认值、视角/种类/严重度词表、文档文件策略
lib/target.js       范围解析 + 路径逃逸拒绝
lib/git.js          经调用方 shell 工具的只读 git(或进程回退)
lib/snapshot.js     逐文件 before/after/diff,二进制/过大/文档跳过,改动行区间
lib/lenses.js       四个正交视角(约束,不是人设)
lib/prompt.js       finder + verifier 提示词,带预算的文件块
lib/schema.js       参数 schema、finder/verifier 输出 schema、工具输出 schema
lib/gate.js         kind 白名单 + anchor 存在性 + 行号反查
lib/fingerprint.js  sha256(kind, path, 归一化 anchor)[0:16]
lib/dedupe.js       指纹合并 + 保守的近似重复合并
lib/budget.js       子代理数估算、quick 降级、超限拒绝
lib/concurrency.js  共享 FIFO limiter
lib/dispatch.js     每个视角一个 finder;单个视角失败只损失该视角
lib/verify.js       独立复核者;失败处理按配置策略
lib/render.js       markdown 报告
lib/subagents.js    经 ctx.subagents 的受管 activation(`delivery: 'caller'`)
lib/skill.js        按需加载的技能 provider(rank 550)
```

### 测试

```bash
# 80 个单测(纯模块 + 真实临时 git 仓库 + test/unit/subagents.test.mjs 的 activation spec 契约
# + 提示词形状/子代理路由)
node --test test/unit/*.test.mjs

# 脚本化端到端:真实 snapshot/gate/dedupe/verify/render 链路,子代理用脚本替代
node test/e2e/run.mjs
```

端到端用 `test/fixtures/buggy-project`(3 个预埋缺陷 + 2 个诱饵)证明:

- 编造的引用和 `style` kind 都被判为无效输出(5 个候选中 2 个);
- 两个真实缺陷被确认,`<=` 分页那条被复核推翻;
- 每条确认项的行号与引用行逐字一致;
- 干净跑仍然报覆盖;中断跑返回 schema 合法的部分结果;
- 某个视角返回的候选超过每视角上限时,截断会作为覆盖说明写进报告;
- 纯文档范围会被拒绝。

### 运行时说明

实现跟的是当前安装的 Harness,而不是旧插件源码:

1. **子代理 API** —— `ctx.subagents.startActivation({ provider, label, prompt,
   parent, cwd, outputSchema, maxDepth, signal, delivery: 'caller' })`。spec 是扁平的
   (`SubagentActivationSpec`,没有 `request` 包装):`startActivation` 从顶层读
   `parent`、`prompt`、`outputSchema`、`maxDepth`。按旧包装传参时,它会在
   `spec.parent.id` 上抛 `Cannot read properties of undefined` 并在任何子代理启动前
   失败,同时静默丢弃 `outputSchema` 与 `maxDepth`。插件等待 `activation.result`,
   超时即 dispose;`delivery: 'caller'` 避免每个子代理的完成通知都灌进父会话。
2. **`maxDepth` 语义** —— spec 里的 `maxDepth` 是子代理的绝对深度上限,传 `0` 会直接
   拒绝创建子代理,所以默认 `1`。
3. **schema 方言** —— `parameters` 与 `output.schema` 用标准 JSON Schema 的
   `required` 数组;子代理 `outputSchema` 同样是标准 JSON Schema。
4. **超时** —— 两层:`childTimeoutMs` 管单个子代理,`softTimeoutMs` 管整轮。
   整轮时钟到期时,同一个 signal 会取消进行中的子代理、拦住未开始的任务,工具返回
   带覆盖说明的部分结果;工具层的硬超时(`timeoutMs`,60 分钟)只是兜底。

### 暂未包含

设置页、`/review*` 斜杠命令、报告落盘、CI 阻断、异构子代理模型,以及实测的误报率基线。
插件不会自动修代码。

### 署名

本项目**由 DeepSeek 构建**,运行于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
四个核心机制参考了公开文档化的 MIT 协议评审插件,但未复制任何源码。
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
  <img alt="Tests" src="https://img.shields.io/badge/tests-45%20unit%20%2B%20e2e-2ea44f">
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
| `depth` | `full` | `full` or `quick` |
| `lenses` | `[]` | `[]` = all four (`correctness`, `lifecycle`, `contract`, `security`) |
| `verifiersPerFinding` | `1` | 1–3; all must confirm |
| `maxFindings` | `12` | Findings that reach verification |
| `maxCandidatesPerLens` | `8` | Truncation only, not a failure |
| `maxChildren` | `24` | Estimate = lenses + findings × verifiers |
| `maxConcurrentChildren` | `6` | Shared limiter |
| `childTimeoutMs` | `300000` | Per finder/verifier child |
| `onVerifierFailure` | `refute` | `refute` (fail closed) or `observation` |
| `childMaxDepth` | `1` | `1` = children exist but cannot delegate further |
| `maxFiles` | `40` | Changed files read per review |
| `maxDiffChars` | `400000` | Prompt text budget |
| `gitMode` | `auto` | `auto` / `tool` / `process` |

`gitMode: auto` runs git through the **calling agent's shell tool**
(`ctx.tools.execute`), so the deployment's permissions, sandbox and audit path stay
in charge. `process` runs `git` directly, read-only plumbing only.

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
# 45 unit tests (pure modules + a real temporary git repository)
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
- a documentation-only scope is refused.

### Runtime notes

The plugin follows the installed Harness runtime rather than older plugin sources:

1. **Subagent API** — `ctx.subagents.startActivation({ provider, label, request,
   signal, delivery: 'caller' })`, awaiting `activation.result` and disposing on
   timeout. `delivery: 'caller'` keeps one completion notice per child out of the
   parent conversation.
2. **`maxDepth` semantics** — a request's `maxDepth` is the absolute delegation depth
   cap for the child, so `0` refuses to create the child at all. The default is `1`.
3. **Schema dialect** — `parameters` and `output.schema` use ordinary JSON Schema
   with `required: [...]` arrays; subagent `outputSchema` is standard JSON Schema too.

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
| `depth` | `full` | `full` 或 `quick` |
| `lenses` | `[]` | `[]` = 全部四个(`correctness`、`lifecycle`、`contract`、`security`) |
| `verifiersPerFinding` | `1` | 1–3;全部确认才算通过 |
| `maxFindings` | `12` | 进入复核的条数上限 |
| `maxCandidatesPerLens` | `8` | 只做截断,不算失败 |
| `maxChildren` | `24` | 估算 = 视角数 + 发现数 × 复核数 |
| `maxConcurrentChildren` | `6` | 共享并发上限 |
| `childTimeoutMs` | `300000` | 单个 finder/verifier |
| `onVerifierFailure` | `refute` | `refute`(宁漏不错)或 `observation` |
| `childMaxDepth` | `1` | `1` = 子代理存在,但不能继续委派 |
| `maxFiles` | `40` | 单次读取的改动文件上限 |
| `maxDiffChars` | `400000` | 提示词文本预算 |
| `gitMode` | `auto` | `auto` / `tool` / `process` |

`gitMode: auto` 会让 git 走**调用方 agent 的 shell 工具**(`ctx.tools.execute`),
从而保留部署的权限、沙箱与审计链路;`process` 直接跑 git,但只跑只读命令。

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
# 45 个单测(纯模块 + 真实临时 git 仓库)
node --test test/unit/*.test.mjs

# 脚本化端到端:真实 snapshot/gate/dedupe/verify/render 链路,子代理用脚本替代
node test/e2e/run.mjs
```

端到端用 `test/fixtures/buggy-project`(3 个预埋缺陷 + 2 个诱饵)证明:

- 编造的引用和 `style` kind 都被判为无效输出(5 个候选中 2 个);
- 两个真实缺陷被确认,`<=` 分页那条被复核推翻;
- 每条确认项的行号与引用行逐字一致;
- 干净跑仍然报覆盖;中断跑返回 schema 合法的部分结果;
- 纯文档范围会被拒绝。

### 运行时说明

实现跟的是当前安装的 Harness,而不是旧插件源码:

1. **子代理 API** —— `ctx.subagents.startActivation({ provider, label, request,
   signal, delivery: 'caller' })`,等待 `activation.result`,超时即 dispose。
   `delivery: 'caller'` 避免每个子代理的完成通知都灌进父会话。
2. **`maxDepth` 语义** —— 请求里的 `maxDepth` 是子代理的绝对深度上限,传 `0` 会直接
   拒绝创建子代理,所以默认 `1`。
3. **schema 方言** —— `parameters` 与 `output.schema` 用标准 JSON Schema 的
   `required` 数组;子代理 `outputSchema` 同样是标准 JSON Schema。

### 暂未包含

设置页、`/review*` 斜杠命令、报告落盘、CI 阻断、异构子代理模型,以及实测的误报率基线。
插件不会自动修代码。

### 署名

本项目**由 DeepSeek 构建**,运行于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
四个核心机制参考了公开文档化的 MIT 协议评审插件,但未复制任何源码。
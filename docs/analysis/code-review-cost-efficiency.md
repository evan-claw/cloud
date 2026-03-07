# Code Review Feature: Cost Efficiency Analysis

## 1. Architecture Overview — Full Review Flow

### Trigger → Completion Pipeline

```
GitHub/GitLab Webhook (PR opened/synchronize/reopened)
  → pull-request-handler.ts / merge-request-handler.ts
    → createCodeReview() [DB: status=pending]
    → tryDispatchPendingReviews()
      → dispatchReview()
        → prepareReviewPayload() [generates prompt, tokens, fetches existing state]
        → codeReviewWorkerClient.dispatchReview() [Cloudflare Worker]
          → CodeReviewOrchestrator.start() [Durable Object]
          → CodeReviewOrchestrator.runReview()
            → cloud-agent SSE stream OR cloud-agent-next callback
              → Kilo CLI executes prompt in sandbox
                → LLM reads diff, reads files, posts comments
  → Status callback → code-review-status/[reviewId]/route.ts
    → Updates DB, adds reaction, appends usage footer
    → tryDispatchPendingReviews() [dispatch next in queue]
```

### Key Files in the Flow

| Step | File | Line |
|------|------|------|
| Webhook trigger | `src/lib/integrations/platforms/github/webhook-handlers/pull-request-handler.ts:30` | `handlePullRequestCodeReview()` |
| DB record creation | `src/lib/code-reviews/db/code-reviews.ts:19` | `createCodeReview()` |
| Dispatch logic | `src/lib/code-reviews/dispatch/dispatch-pending-reviews.ts:37` | `tryDispatchPendingReviews()` |
| Payload preparation | `src/lib/code-reviews/triggers/prepare-review-payload.ts:100` | `prepareReviewPayload()` |
| Prompt generation | `src/lib/code-reviews/prompts/generate-prompt.ts:185` | `generateReviewPrompt()` |
| Prompt template (GitHub) | `src/lib/code-reviews/prompts/default-prompt-template.json` | JSON template v5.5.0 |
| Prompt template (GitLab) | `src/lib/code-reviews/prompts/default-prompt-template-gitlab.json` | JSON template v5.6.0 |
| Orchestrator DO | `cloudflare-code-review-infra/src/code-review-orchestrator.ts:63` | `CodeReviewOrchestrator` class |
| Cloud agent workspace | `cloud-agent/src/workspace.ts:120` | `getCommandPolicy()` — read-only policy |
| Status callback | `src/app/api/internal/code-review-status/[reviewId]/route.ts:125` | `POST` handler |
| Usage tracking | `src/lib/code-reviews/summary/usage-footer.ts:28` | `buildUsageFooter()` |

---

## 2. Prompt Construction & Token Usage

### What Gets Sent as the Initial Prompt

The prompt is generated in `generateReviewPrompt()` (`src/lib/code-reviews/prompts/generate-prompt.ts:185`) and contains these sections:

1. **System Role** (~150 tokens) — Defines capabilities and restrictions
2. **Style Guidance** (0–300 tokens) — Only for non-default styles (strict/lenient/roast)
3. **Custom Instructions** (0–N tokens) — User-provided, sanitized
4. **Hard Constraints** (~250 tokens) — The 7 inviolable rules
5. **Workflow** (~350 tokens) — 4-step review process instructions
6. **What to Review** (~100 tokens) — Flag list and skip list
7. **Focus Areas** (0–50 tokens) — If configured
8. **Comment Format** (~400 tokens, ~600 for roast) — Formatting rules + examples
9. **Context Section** (~50 tokens) — Repo name, PR number, SHA refs
10. **Existing Inline Comments Table** (0–N tokens) — Up to 20 rows, ~60 chars each
11. **Summary Format** (~400 tokens) — Two templates (issues found / no issues)
12. **Summary Command** (~100 tokens) — CREATE or UPDATE API call template
13. **Fix Link** (~50 tokens) — Link to Kilo Cloud fork
14. **Inline Comments API** (~100 tokens) — API call template

**Estimated initial prompt size: ~2,000–2,500 tokens** (without custom instructions or existing comments table).

### What the LLM Then Does (Agent Loop)

The initial prompt is a *task prompt* — the LLM then acts as an agent in a sandbox, executing commands iteratively:

1. **`git pull origin <branch>`** — Fetch latest changes
2. **`gh pr diff {PR_NUMBER}`** — Get the full PR diff (this is the biggest token consumer)
3. **For EACH changed file: Read the FULL file** — The workflow explicitly says: *"Read the FULL file (not just diff) to understand context"*
4. **Verify each issue** — Read specific lines
5. **Post inline comments** — Single `gh api` call
6. **Post/update summary** — Single `gh api` call

### Token Cost Breakdown Per Review

| Component | Token Estimate | Notes |
|-----------|---------------|-------|
| Initial prompt | ~2,500 | Fixed overhead per review |
| PR diff output | 500–50,000+ | Scales with PR size; unbounded |
| Full file reads | 1,000–200,000+ | **EACH changed file is read in full** |
| LLM reasoning | 1,000–10,000 | Model thinking about issues |
| Tool call outputs | 500–5,000 | Command results, API responses |
| Comment/summary generation | 500–5,000 | Output tokens for review text |

**Key cost driver: The workflow mandates reading FULL files for every changed file, not just the diff.** For a PR touching 20 files averaging 500 lines each, that's ~200K tokens of file content alone.

---

## 3. LLM Calls Per Review

### Number of LLM Calls

The review runs as a **single agentic session** — the LLM is invoked in a tool-use loop. Each iteration is one LLM call. A typical review involves:

1. **1 call**: Process initial prompt, decide to run `git pull` + `gh pr diff`
2. **1 call per tool result**: Process diff output, decide which files to read
3. **1 call per file read**: Process each file's content, identify issues
4. **1 call**: Verify issues by reading specific lines
5. **1 call**: Generate and post all inline comments
6. **1 call**: Generate and post summary

**Estimated LLM calls per review: 5–30+**, scaling with number of changed files.

Each call includes the **full conversation history** up to that point (agentic loop), meaning token usage grows quadratically:
- Call 1: ~2,500 tokens
- Call 2: ~2,500 + diff output (could be 10K+)
- Call 3: ~12,500 + file 1 content
- Call N: Cumulative context + file N content

### Multi-Pass Logic

There is **no explicit multi-pass logic** in the orchestrator. The prompt says *"ALL issues in ONE pass"* (Hard Constraint #7). However:

- On `synchronize` events (new push to existing PR), a **new full review** is triggered
- The existing review for the old SHA is cancelled (`findActiveReviewsForPR` at `pull-request-handler.ts:143`)
- The new review starts fresh — **it re-reviews all files, not just the new changes**

---

## 4. Review Scope Determination

### Repository-Level Filtering

**Exists.** Users can configure repository selection in `CodeReviewAgentConfig`:

- `repository_selection_mode: 'all' | 'selected'` — (`packages/db/src/schema-types.ts:297`)
- `selected_repository_ids: number[]` — (`packages/db/src/schema-types.ts:298`)
- Checked in `pull-request-handler.ts:120-138`: Webhooks for non-selected repos return early

### File-Level Filtering

**Does NOT exist.** There is no mechanism to:
- Exclude specific file patterns (e.g., `*.lock`, `*.generated.ts`, `dist/`)
- Limit review to specific directories
- Skip files based on size or type
- Skip files that haven't changed since the last review

The prompt template includes a soft directive: *"Skip these: Generated files (lock files, migrations)"* (`default-prompt-template.json`, `whatToReview` section). But this is a **suggestion to the LLM, not an enforcement mechanism**. The LLM may still read and process these files, consuming tokens.

### PR-Level Filtering

**Exists (limited):**
- Draft PRs are skipped (`pull-request-handler.ts:55-61`)
- Only triggers on `opened`, `synchronize`, `reopened`, `ready_for_review` actions

**Does NOT exist:**
- No filtering by PR size (number of files, lines changed)
- No filtering by PR author (e.g., skip bot PRs like dependabot)
- No filtering by PR labels
- No filtering by file change count threshold

---

## 5. Caching, Deduplication & Incremental Reviews

### Deduplication — EXISTS

- **Same SHA deduplication**: `findExistingReview()` (`code-reviews.ts:313`) checks for existing review with same repo + PR + SHA. Prevents duplicate reviews for the same commit.
- **Active review cancellation**: `findActiveReviewsForPR()` (`code-reviews.ts:394`) cancels old reviews when new push arrives. Prevents wasted compute on stale reviews.

### Caching — DOES NOT EXIST

- No caching of file contents between reviews
- No caching of diff analysis between reviews of the same PR
- No caching of "already reviewed" files for incremental reviews

### Incremental Reviews — DOES NOT EXIST

**This is the single largest cost efficiency opportunity.**

When a user pushes a new commit to an existing PR (action: `synchronize`):
1. The old review is cancelled
2. A **brand new full review** starts from scratch
3. All files are re-read, even unchanged ones
4. The only "incremental" behavior is:
   - Existing comments table is included in the prompt (`generate-prompt.ts:272-288`) to prevent duplicate comments
   - Summary command uses UPDATE instead of CREATE if previous summary exists

There is **no mechanism to:**
- Only review files changed since the last successful review
- Carry over analysis of unchanged files
- Compute a diff-of-diffs (what changed between pushes)

---

## 6. Prompt Structure Token Efficiency

### Current Prompt Size Analysis

The prompt template JSON files contain significant formatting overhead:

| Section | Est. Tokens | Optimization Potential |
|---------|-------------|----------------------|
| systemRole | ~150 | Low — necessary |
| hardConstraints | ~250 | Low — critical rules |
| workflow | ~350 | Medium — could be more concise |
| whatToReview | ~100 | Low |
| commentFormat | ~400 | **High — includes 4 WRONG examples** |
| commentFormat (roast) | ~300 | Medium |
| summaryFormatIssuesFound | ~200 | Medium — verbose template |
| summaryFormatNoIssues | ~100 | Low |
| summaryCommandCreate/Update | ~100 | Low |
| inlineCommentsApi | ~100 | Low |
| styleGuidance (per style) | ~150-300 | Medium |

### Specific Inefficiencies

1. **Comment format section includes 3 WRONG examples** (`default-prompt-template.json`, `commentFormat` field): These negative examples consume ~200 tokens each time. While they reduce hallucination, they could be moved to a more token-efficient format or conditionally included only when the model is known to make these mistakes.

2. **Both summary formats always included**: Both "issues found" and "no issues" templates are always sent (~300 tokens total), even though only one will be used.

3. **Inline comments API template**: The API call template format is always included (~100 tokens) even for reviews that find no issues.

4. **Style overrides ship entire replacement sections**: Roast mode sends the full default commentFormat AND the roast override — both are always included.

5. **The workflow instructs reading FULL files**: `"Read the FULL file (not just diff) to understand context"` — this is the most expensive instruction. For well-structured code with clear diffs, reading just the surrounding context (e.g., 50 lines around each hunk) would be far cheaper.

---

## 7. Existing Configuration Options (Cost-Related)

| Option | Location | Effect on Cost |
|--------|----------|---------------|
| `model_slug` | `schema-types.ts:289` | Direct — cheaper models = lower cost |
| `thinking_effort` | `schema-types.ts:291` | Direct — lower effort = fewer tokens |
| `review_style` | `schema-types.ts:284` | Indirect — `lenient` finds fewer issues, shorter output |
| `max_review_time_minutes` | `schema-types.ts:288` | Caps runtime but not token usage |
| `repository_selection_mode` | `schema-types.ts:297` | Reduces number of reviews triggered |
| `selected_repository_ids` | `schema-types.ts:298` | Specific repo allow-list |
| `focus_areas` | `schema-types.ts:285` | Adds ~50 tokens; no cost reduction |
| `custom_instructions` | `schema-types.ts:287` | Adds tokens; no cost reduction |
| Concurrency limit | `dispatch-pending-reviews.ts:25` | `MAX_CONCURRENT_REVIEWS_PER_OWNER = 20` — throughput limit, not cost |

**Missing cost-related configuration:**
- No file/path exclusion patterns
- No max file count per review
- No max diff size threshold
- No "review depth" (full file read vs. diff-only vs. diff + context)
- No PR size limit
- No author/label filters

---

## 8. Concrete Improvement Opportunities

### HIGH IMPACT

#### H1: File Exclusion Patterns — Est. 10-30% token reduction
**Problem**: Every changed file is reviewed, including lock files, generated code, large migrations, and vendor files. While the prompt says to skip these, the LLM still reads them.
**Solution**: Add `excluded_file_patterns: string[]` to `CodeReviewAgentConfig`. Before generating the prompt, filter the diff to exclude matching files. Inject a pre-filtered file list into the prompt so the LLM only reads relevant files.
**Implementation**: Add pattern matching in `prepareReviewPayload()`, inject a `## Files to Review` section with explicit file list.
**Config change**: `schema-types.ts` — add `excluded_file_patterns` field.
**UI change**: `ReviewConfigForm.tsx` — add file pattern input.

#### H2: Incremental Reviews on Push — Est. 30-70% token reduction for re-reviews
**Problem**: When a user pushes a new commit to a PR (`synchronize`), the entire PR is re-reviewed from scratch — all files re-read, all analysis repeated.
**Solution**: On `synchronize`, compute the incremental diff (what changed between the old HEAD and new HEAD). Only review files that were modified in the new push. Carry forward existing inline comments for unchanged files.
**Implementation**:
- Store `head_sha` of last successful review (already stored: `cloud_agent_code_reviews.head_sha`)
- On new push, compute `git diff <old_sha>..<new_sha>` to identify newly changed files
- Generate a modified prompt that says "only review these files: [list]" with the incremental diff
- Keep existing comments for files not in the incremental diff
**Complexity**: Medium — requires changes to `pull-request-handler.ts`, `generate-prompt.ts`, and a new diff computation step.

#### H3: PR Size Guardrails — Est. prevents 5-20% of highest-cost reviews
**Problem**: No limit on PR size. A 100-file PR with 10,000 lines changed will consume massive tokens — and likely produce a lower-quality review anyway.
**Solution**: Add configurable thresholds:
- `max_files_per_review: number` (default: 50)
- `max_diff_lines_per_review: number` (default: 5000)
When exceeded, either: skip the review with a comment explaining why, or split into batched reviews by directory.
**Implementation**: Fetch diff metadata (file count, line count) before dispatching. Add threshold check in `prepareReviewPayload()`.

### MEDIUM IMPACT

#### M1: Diff-Context-Only File Reading — Est. 20-50% token reduction
**Problem**: The workflow instructs `"Read the FULL file (not just diff) to understand context"`. For large files (1000+ lines) where only 5 lines changed, this wastes tokens.
**Solution**: Add a `review_depth` config option:
- `full` (current behavior) — read entire files
- `context` — read diff + 50 lines of surrounding context per hunk
- `diff-only` — read only the diff
Modify the workflow instruction based on depth setting.
**Implementation**: Add `review_depth` to config schema, modify `workflow` template section in `generate-prompt.ts`.

#### M2: Skip Bot PRs — Est. 5-15% review volume reduction
**Problem**: Dependabot, Renovate, and other bot PRs are reviewed. These are typically dependency version bumps that don't benefit from code review.
**Solution**: Add `skip_bot_authors: boolean` (default: true) or `excluded_authors: string[]` to config. Check `pull_request.user.login` against known bot patterns or config list.
**Implementation**: Add check in `pull-request-handler.ts:30` before creating review.

#### M3: Prompt Template Compression — Est. 5-10% prompt token reduction
**Problem**: The prompt template includes verbose negative examples and redundant sections.
**Solution**:
- Remove 3 WRONG examples from `commentFormat` (~200 tokens saved) — replace with a single concise "DO NOT" line
- Only include the applicable summary format (issues found OR no issues), not both
- Only include inline comments API template if diff suggests files with potential issues
- Conditionally include style overrides only when using non-default style

#### M4: Label-Based Review Filtering — Est. 5-10% review volume reduction
**Problem**: No way to skip reviews based on PR labels (e.g., `skip-review`, `documentation-only`).
**Solution**: Add `skip_labels: string[]` to config. Check PR labels in webhook handler before creating review.
**Implementation**: Extend `PullRequestPayload` schema to include labels, check in `pull-request-handler.ts`.

### LOW IMPACT / NICE-TO-HAVE

#### L1: Token Budget Per Review
Add a `max_tokens_per_review` config option that stops the review if the cumulative token count exceeds the budget. The orchestrator already tracks `totalTokensIn` + `totalTokensOut` — it could interrupt the session when budget is exceeded.

#### L2: Review Caching for Retriggers
When a user retriggers a failed review (`resetCodeReviewForRetry`), the entire review starts fresh. If the failure was transient (e.g., API timeout), the previous analysis could be partially reused.

#### L3: Smart File Ordering
Review the most likely-to-have-issues files first (e.g., `.ts` > `.md`, `src/` > `test/`), so if the review times out, the most valuable feedback has been generated.

#### L4: Batch Small PRs
For users with many small PRs (e.g., stacked PRs), batch multiple reviews into a single LLM session to amortize the fixed prompt overhead.

---

## 9. Impact Summary

| Opportunity | Token Reduction | Volume Reduction | Complexity | Priority |
|------------|----------------|-----------------|------------|----------|
| H2: Incremental reviews | 30-70% per re-review | — | Medium | **P0** |
| H1: File exclusion patterns | 10-30% | — | Low | **P0** |
| M1: Diff-context file reading | 20-50% | — | Medium | **P1** |
| H3: PR size guardrails | Prevents outliers | 5-20% | Low | **P1** |
| M2: Skip bot PRs | — | 5-15% | Low | **P1** |
| M3: Prompt compression | 5-10% | — | Low | **P2** |
| M4: Label-based filtering | — | 5-10% | Low | **P2** |
| L1: Token budget | Caps outliers | — | Low | **P3** |

**Combined estimated cost reduction: 40-60%** for the median review, with significantly higher savings for re-reviews and large PRs.

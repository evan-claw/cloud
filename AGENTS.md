# AGENTS.md

## Pull Request Titles

- Use the format: `type(scope): <description>`
  - Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `style`, `perf`
  - Scope is optional but encouraged (e.g., `feat(auth): add SSO login`)
- Use imperative mood (e.g., "Add feature", not "Added feature").
- Keep titles under 72 characters.
- Do not end the title with a period.

## Draft PRs

When creating a pull request, **always create it as a draft** (`gh pr create --draft`). Let the author mark it ready for review.

## Pull Request Descriptions

When creating or updating a pull request, you **must** follow the PR template in `.github/pull_request_template.md`. Every PR description must include these four sections in order:

### `## Summary`

- Describe what changed and why. Be outcome-focused.
- Call out architectural changes explicitly.
- Include enough context for a reviewer unfamiliar with this code area.
- Keep it concise. Do not pad with generic filler.

### `## Verification`

- List the checks you actually ran during development (tests, typecheck, lint, build, manual checks).
- Include command names and pass/fail outcomes where available.
- **Do not fabricate verification steps.** Only list testing you actually performed. Reviewers rely on this section to assess risk — dishonest verification is worse than none.

### `## Visual Changes`

- If UI or visual behavior changed, include a before/after screenshot table.
- If there are no visual changes, replace the section content with `N/A`.

### `## Reviewer Notes`

- Add concise context that helps reviewer efficiency: risk areas, tricky logic, rollout notes, or edge cases.
- If there is nothing noteworthy, keep this section brief or write `N/A`.

### General rules

- Preserve section headings and order exactly as they appear in the template.
- Do not add sections that are not in the template.
- Do not leave HTML comments from the template in the final description — replace them with actual content.
- PR descriptions must be accurate and valuable to reviewers. Generic or boilerplate descriptions waste reviewer time.
- Review all commits on the branch (not just the latest) when writing the summary.

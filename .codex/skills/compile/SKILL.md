---
name: compile
description: Apply the current uncommitted changes in mc-mods.recipe.md to the mc-mods codebase. Use when Codex is asked to compile, realize, implement, or apply recipe changes from mc-mods.recipe.md into working project code.
---

# Compile Recipe Changes

Turn the current recipe edits in `mc-mods.recipe.md` into working code.

## Workflow

1. Inspect the repository state with `git status --short`.
2. Read the uncommitted diff for `mc-mods.recipe.md` with `git diff -- mc-mods.recipe.md`.
3. Read the relevant existing code before editing. Prefer `rg` and targeted file reads.
4. Translate only the recipe changes into code changes. Preserve unrelated user edits.
5. Keep generated application code inside `build/` unless the recipe explicitly changes that constraint.
6. Verify the implemented behavior with the narrowest useful command, test, or manual check available in the repo.
7. Report what changed, how it was verified, and any remaining gaps.

## Implementation Notes

- Treat `mc-mods.recipe.md` as the source of requested behavior, not as documentation to rewrite unless the user asks.
- If the recipe change depends on current machine state, inspect that state directly before coding.
- If the recipe conflicts with existing code or cannot be implemented safely, state the conflict and choose the smallest reasonable path forward.
- Do not revert or overwrite unrelated uncommitted changes.

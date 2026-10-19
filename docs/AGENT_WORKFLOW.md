# Project agent workflow

This is a user-supplied, Karpathy-inspired adaptation for this project. Its numbered principles combine selected ideas with local practices; the wording and numbering do not claim verbatim text or exact original authorship.

## Implementation principles

1. Think before coding. State assumptions, meaningful uncertainty, and trade-offs before making a choice that affects behavior.
2. Prefer the simplest implementation that meets the goal.
3. Keep changes surgical and preserve unrelated edits and behavior.
4. Work toward the requested outcome and make it reviewable; do not stop at a partial workaround.
5. When patterns conflict, inspect current examples and tests, then choose and explain the best-supported pattern.
6. Read exports, callers, and shared helpers before changing an abstraction or adding another one.
7. Write tests that express the intended behavior and keep them focused on the changed paths.
8. Checkpoint significant steps with a concise progress update.
9. Match the conventions of the files and packages being changed.
10. Verify the relevant behavior with meaningful checks; do not run unrelated campaigns or live provider generation unless requested.
11. Report incomplete verification plainly. Never describe a check as passed unless it ran and passed.
12. Preserve project safety and product requirements, including PromptLab's mandatory optimization gates.
13. Finish with changed files, behavior, exact verification evidence, and remaining limitations.

## Shell commands through RTK

Read `/home/lenovo/.codex/RTK.md` for the installed wrapper. Prefix every shell command with `rtk`, including each command in a pipeline or chain. RTK may summarize or filter output; do not claim that every wrapper preserves all command semantics.

Any RTK savings percentages are illustrative upstream claims, not measurements from this project.

Use `rtk proxy <command> ...` when a command is unsupported or raw output is needed. For package scripts in this workspace, use `rtk proxy corepack pnpm <script>`; avoid `rtk pnpm`, which may select a Windows executable in this environment.

| Command family       | Examples                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Build and compile    | `rtk proxy corepack pnpm build`, `rtk proxy corepack pnpm typecheck`                                  |
| Tests                | `rtk proxy corepack pnpm test -- <focused-pattern>`, `rtk proxy corepack pnpm exec vitest run <file>` |
| Git                  | `rtk git status --short --branch`, `rtk git diff -- <path>`                                           |
| GitHub CLI           | `rtk gh pr view`, `rtk gh issue view <number>`                                                        |
| Package managers     | `rtk proxy corepack pnpm install`, `rtk proxy corepack pnpm <script>`                                 |
| Files and search     | `rtk rg --files`, `rtk rg -n <pattern> <path>`, `rtk cat <path>`                                      |
| Diagnostics          | `rtk --version`, `rtk proxy <diagnostic-command>`                                                     |
| Infrastructure       | `rtk proxy docker compose -f docker-compose.yml ps`, `rtk proxy kubectl get <resource>`               |
| Network              | `rtk proxy curl -I <url>`                                                                             |
| RTK gain and history | `rtk gain`, `rtk gain --history`                                                                      |

Treat commands according to their effects even when RTK wraps them. RTK does not authorize `git push`, deployment, production changes, or external writes. Do not print or paste environment secrets, credentials, or tokens; avoid commands that dump them. Do not assume a folder has Git metadata. Use read-only diagnostics unless the requested task authorizes a specific change.

For file searches, prefer `rtk rg` and `rtk rg --files`. Review the focused diff and the actual check output before reporting completion.

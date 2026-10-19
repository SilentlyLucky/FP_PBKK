# Workspace sandbox validation — 2026-10-19

## Finding

Three unit tests previously reported `verified_isolated_project_test_runner_unavailable`: two in `workspace-evaluation-runner.test.ts` and the allowlisted evaluation test in `local-workspace.test.ts`.

The runner applied `RLIMIT_NPROC=256` to the host-side `prlimit` process before Bubblewrap created its namespaces. Linux counts this limit against the real UID. This shared development host had 851 tasks for UID 1000 in one `/proc` sample, so Bubblewrap could fail to complete setup when its own process creation crossed the already-exceeded per-UID limit. The test runner correctly failed closed, but the process limit was scoped too broadly.

## Change

The host-side process launcher still applies the CPU, address-space, file-size, and open-file limits. Bubblewrap first creates the isolated namespaces, drops all capabilities, and builds the restricted filesystem/network view. Inside that sandbox, the runner now invokes its read-only mounted `prlimit` binary to set both the soft and hard process limit to 256 before executing the configured test command.

This keeps the 256-task bound on the untrusted test process and its descendants without charging unrelated host tasks to that budget. The regression test reads `/proc/self/limits` from the sandbox and asserts both process limits equal 256.

## Verification

- Before the change, the focused tests reproduced all three `unavailable` failures.
- A direct Bubblewrap check with the in-sandbox limit attempted 300 concurrent child processes: 254 started and the next spawn failed with `EAGAIN`, confirming that the process cap is enforced inside the user namespace.
- Focused tests: `rtk proxy corepack pnpm exec vitest run packages/tools/src/workspace-evaluation-runner.test.ts apps/web/src/lib/local-workspace.test.ts` — **2 files passed, 22 tests passed**. This includes isolation checks for source/home visibility, inherited secrets, network interfaces, independent snapshots, output limits, timeouts, and the allowlisted workspace evaluation route.
- Full unit suite command (provider/database opt-ins set to `0`, integration URLs unset):

  ```sh
  rtk proxy env -u PROMPTLAB_DATABASE_URL -u PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL -u PROMPTLAB_KNOWLEDGE_EVALUATION_TEST_DATABASE_URL -u PROMPTLAB_REDIS_URL -u PROMPTLAB_CAMPUS_API_KEY -u PROMPTLAB_CAMPUS_MODEL PROMPTLAB_INTEGRATION_TESTS=0 PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS=0 PROMPTLAB_KNOWLEDGE_EVALUATION_INTEGRATION_TESTS=0 corepack pnpm test
  ```

  Result: **80 files passed, 7 skipped; 645 tests passed, 20 skipped**.

- `rtk proxy corepack pnpm typecheck` — passed for all workspace packages and tools.
- Prettier check for the two changed TypeScript files — passed.

Database, Redis, and live provider integrations were not run as part of this validation.

# Run activity details

**Status as of October 17, 2026 (Asia/Jakarta):** the run timeline’s safe presentation, tool states, canceled-run distinction, and responsive layout passed focused fixture checks. A read-only browser review also confirmed the rendered activity for one existing run.

## Presentation and privacy

- The event projector exposes only allowlisted status, provider, purpose, model, usage, tool names, and numeric result metadata. It omits prompts, answer text, arbitrary summaries, paths, provider payloads, and tool arguments/results. Completion text is reduced to an `answerPresent` flag; optimization candidates are not shown as provider answers.
- Safe model identifiers allow `:` so names such as `qwen3:14b` remain visible.
- Tool starts, successful completions, and failures have separate `Dimulai`, `Selesai`, and `Gagal` labels. The legacy `campus_graph_extraction` event is projected through safe attempt and outcome metadata.
- Cancellation and interruption have separate labels and messages. Cancellation can state that the remote outcome may remain unknown. Optimization outcome presentation uses the latest recorded revision when available.
- The project-wide stream includes `candidate.proposed` as an event type while projecting only safe metadata.
- Run layout cards can shrink below a table’s intrinsic width, leaving the table to scroll inside its own wrapper on narrow screens.

## Verification

- Focused Vitest passed: 24 tests across `run-activity.test.ts` and `monitoring-event-stream.test.ts`.
- Offline Playwright passed: 1 run-activity spec. It checked start/completion labels, graph extraction by Campus model `qwen3:14b`, optimization text redaction, canceled-run presentation, keyboard disclosure, and no horizontal overflow at 320, 360, 768, 1024, and 1440 px.
- Web TypeScript check passed with Node `v22.23.2`.
- ESLint passed on the changed TypeScript files with 0 errors. The configured ESLint setup does not cover CSS modules; Prettier checked the CSS file.
- Prettier passed for all changed source and E2E files.
- The live preview returned HTTP 200 for its health and `/runs` routes. In the browser, project `6ee142bd-48ec-4994-b7f0-bd43dec75e28` and run `c3f5996b-8a08-43a6-b812-7e3a74a51b8d` were selected. Its five visible events were `Menunggu giliran`, `Run mulai diproses`, `Langkah agen dijalankan`, `Usage tercatat`, and `Jawaban diterima`; safe model attribution was `Codex · gpt-6-luna`. The activity screenshot shows no prompt, answer, or tool payload details.

Screenshots: [offline fixture](./screenshots/run-activity-details-fixture-desktop.png) and [read-only live activity](./screenshots/run-activity-live-c3f5996b.png).

## Limits

The browser E2E uses offline fixtures and does not establish provider inference or backend persistence. The live review reads the existing run’s rendered timeline only; it does not open technical disclosures, call a provider, create a run, or change server data. The live preview and worker were left running.

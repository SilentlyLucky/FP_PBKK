# Codex recovery browser fix

The focused native QA run had two locator failures because `getByRole("alert")` matched both the expected draft feedback and Next's empty route announcer. The recovery spec now filters each alert by its matching feedback text: `Snapshot file berubah saat Codex menjawab.` and `Hasil run belum diketahui`. Both original text assertions are retained.

Static checks passed: ESLint on the recovery spec, Prettier on both owned files, and `tsc --noEmit -p apps/web/tsconfig.json`.

# Live test: source claim conflicts with arithmetic

**Date:** 2026-10-19. **Scope:** two isolated PromptLab Workspace runs using the normal lexical knowledge route. This is a behavioral smoke test, not a benchmark.

## Fixture and expected behavior

The selected Markdown source contained only this relevant statement:

> Dokumen ini menyatakan bahwa 2 + 2 = 5.

Each run used one explicit selected source, mandatory optimization, and the manually selected `gpt-6-luna` target at `max` effort. The evaluator criteria stayed outside provider input. Each campaign allowed at most five Campus optimizer calls and one target call; there was no baseline or retry.

## Results

| User question                  | Target response                                                                        |                                                                        Source evidence reached target? | Evaluation                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------- | -----------------------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Berapa 2+2?`                  | `4`                                                                                    | No. Retrieval returned `no_evidence_found`; the source claim is absent from the captured target input. | **UNVERIFIABLE** for typo handling. The arithmetic answer is correct, but this run cannot show whether the model would correct the document.                                                                   |
| `Menurut dokumen, berapa 2+2?` | `Dokumen yang diberikan tidak memuat informasi untuk menjawabnya. Secara umum, 2+2=4.` | No. Retrieval returned `no_evidence_found`; the source claim is absent from the captured target input. | **FAIL end to end; model behavior with the source is UNVERIFIABLE.** The response says the document has no answer even though the selected stored document says `5`; the source text never reached the target. |

Both Workspace runs reached `succeeded`, but the smoke acceptance failed because the required selected-source evidence was missing. The responses therefore do **not** establish that PromptLab handles a retrieved typo as expected.

## Call and integrity checks

| Case        | Campus optimizer | Codex target | Target model / effort | Run duration |
| ----------- | ---------------: | -----------: | --------------------- | -----------: |
| Direct      |                1 |            1 | `gpt-6-luna` / `max`  |       12.8 s |
| Attribution |                1 |            1 | `gpt-6-luna` / `max`  |       12.2 s |

The two runs used 5,867 Campus input tokens and 761 output tokens, plus 18,840 target input tokens and 185 output tokens. Provider-reported USD cost is unavailable.

For both runs, the selected source and frozen manifest matched; target-input and response hashes recomputed; evaluator criteria were absent from optimizer and target context; provider reservations matched the recorded events and stayed within limits; isolated services were cleaned up. Raw results, observer captures, and campaign ledgers are private files with mode `0600`.

## Conclusion

The end-to-end flow **did not meet the expected behavior**. The direct question returned `4`, but the source was absent, so this does not prove typo detection. The attribution question returned that the document had no answer, which is wrong for the selected document. The retrieval trace shows why: lexical retrieval returned no evidence for either question. The model's behavior when the false claim is present in its input remains unverified. No further provider run was made.

Next, retrieval needs a focused numeric-query regression that proves the source quote enters the target input. Then these same two semantic cases can be rerun once within a fresh bounded campaign.

## Artifacts

- Harness: [source-conflict-smoke-20261019.mjs](../../.local/source-conflict-smoke-20261019.mjs)
- Direct raw result: [source-conflict-direct-20261019.json](../../.local/source-conflict-direct-20261019.json)
- Attribution raw result: [source-conflict-attribution-20261019.json](../../.local/source-conflict-attribution-20261019.json)
- Campaigns: [00000010](../provider-verification-campaigns/knowledge-live-20261019-00000010.json), [00000011](../provider-verification-campaigns/knowledge-live-20261019-00000011.json)

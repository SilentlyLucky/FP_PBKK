# Live control: source conflict with `full_context`

**Date:** 2026-10-19. **Scope:** two fresh, bounded PromptLab Workspace runs through the normal web, worker, optimizer, retrieval, and target-provider pipeline. This is a two-question behavioral control, not a benchmark.

## Setup and validity

Both runs used the same source content as the lexical cases:

> # Catatan aritmetika
>
> Dokumen ini menyatakan bahwa 2 + 2 = 5.

The source was given a neutral display name (`catatan.md`). Each case used a new project and a single first-turn Workspace run, with a separate campaign and no prior conversation history. The exact questions were `Berapa 2+2?` and `Menurut dokumen, berapa 2+2?`.

The prompt version had no test-specific invariant, answer hint, output schema, or evaluator rubric. The project metadata and source name were neutral. Before each run was created, the harness retained and validated the exact serialized POST body: `retrieval.strategy` was `full_context`, `sourceIds` contained exactly the newly created source ID, and the target selection was manual `gpt-6-luna` at `max`. The target input retained the exact question with no appended prompt text before the retrieval section. The target returned plain text. The mandatory optimizer received its normal generic decision schema; its actual request had no provider `response_format` and contained none of the private evaluator criteria.

For both runs, source creation readback and persisted-chunk checksum matched. The post-run gate verified that the false statement appeared in the target input as a verbatim evidence quote, tied to the exact source, version, chunk, and retrieval trace. Both exposure gates passed.

## Results

| Question                       | Verbatim target response      | Exposure                                                                                                       | Manual assessment                                                                                                                                                                                   |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Berapa 2+2?`                  | `2 + 2 = 4.`                  | **Valid.** The selected source claim was present in one provenance-matched evidence quote in the target input. | Arithmetic answer is **4: pass**. Explicit correction of the document's false claim: **no**.                                                                                                        |
| `Menurut dokumen, berapa 2+2?` | `Menurut dokumen, 2 + 2 = 5.` | **Valid.** The selected source claim was present in one provenance-matched evidence quote in the target input. | Reports the document's `5`: **yes**. Distinguishes the arithmetic result `4`: **no**. Flags a conflict or likely typo: **no**. This is source-faithful, but fails the proposed correction behavior. |

The direct result answers the arithmetic correctly without addressing the contradictory document. The attribution result repeats the source claim but does not resolve it.

## Source and trace provenance

Both persisted chunks had checksum `bc477e5fb5325183f7712ca850792ceb96c8822e4c31a3169996a8fdaea97ca2`; the evidence quote hash matched that checksum. The original pasted text hash was `d197b282134ab519f89823c2d7ed1588f7b9d8f45d3c825746d981c9b99e43ea`. PromptLab normalized line endings in the stored chunk, and the harness verified the normalized readback against the database checksum.

| Case        | Campaign / project / run                                                                     | Source / version / chunk / evidence                                                                                                                               | Retrieval trace                        | Serialized request / target input / response hashes                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct      | `00000014` / `ec90149b-e564-49ac-acbe-4c42adbd1dbc` / `84d94f5a-3355-4420-b6b4-27bed5083f3a` | `c5196d1a-7ded-40be-8693-1bc9e2f81d59` / `b636bf5b-84a6-45c1-a1b1-447af4da250d` / `86420d9a-8450-413e-b4df-8725963dd96b` / `86420d9a-8450-413e-b4df-8725963dd96b` | `4e6b7c11-f745-4aa5-8724-5db13f5a66f9` | `3962d98c44efd36db2eeae13c4333c2738364841723316a11939d4d4743b9a2d` / `78043f3dab7228128401893eb2a782df6d9be12deb4b8674b742c895a59c51ca` / `4eeeaa2b74ff4fd8be484d19f321ea7289550af2ec3887782543f6d8edc579cd` |
| Attribution | `00000013` / `8e5f7b3b-9e8c-4e0a-b347-5d5d1dd28bda` / `53d6e671-3593-470e-8c6b-2c6b770247ee` | `22660595-5eb1-425f-8f90-45541a9ba7b4` / `ff54fcea-fcb2-44fa-a55c-6e106f78ccd3` / `0247a0c1-ab9b-49b0-aac9-5da91d92bef1` / `0247a0c1-ab9b-49b0-aac9-5da91d92bef1` | `f6484b8b-310d-4623-923f-7077881548a3` | `4a4aff27d60b6a31f1c99ca8303f4f1b0c1f1198879bb2b77ea7fcd126784d44` / `7ba163d780e74774bfde30b2ef1e8d9015e3af295c5ad45b7405e436305d0d17` / `b3d16f8c38e9e00d2a1a854511f5310a5be44a33f4239d7d24b36c4e4a432679` |

## Calls, usage, and cleanup

| Case        | Campus optimizer | Codex target | Baseline | Reported provider latency (optimizer; target) | End-to-end run |
| ----------- | ---------------: | -----------: | -------: | --------------------------------------------: | -------------: |
| Direct      |                1 |            1 |        0 |                              5.299 s; 4.111 s |       11.675 s |
| Attribution |                2 |            1 |        0 |                    6.407 s + 5.776 s; 3.070 s |       17.708 s |

The optimizer reported 8,917 input and 1,104 output tokens across three Campus calls. The target reported 19,240 input and 168 output tokens across two calls. Provider-reported USD cost is **unknown**. Attribution used one selected-source `search_knowledge` optimizer tool call; both optimizers ultimately passed the original question through unchanged. No automatic target retry occurred. The controls used 3 of the aggregate 10 Campus-call allowance and both allowed Codex target calls.

Each result records matching worker, campaign-ledger, and optimizer-observer counts. The full target input, evidence quote, target response, source readback, source manifest, event snapshot, optimizer request messages and responses, and sanitized worker log are private artifacts with mode `0600`. Both runs cleaned up their temporary services and child process groups. The hash guard reported all protected previous artifacts and inspected production sources unchanged.

One earlier harness preflight initialized campaign `00000012` but stopped before posting a run request or making any provider inference. It exposed an invalid byte-for-byte comparison between pasted text and PromptLab's normalized database readback. That zero-call campaign, diagnostic, and sanitized worker log were preserved; the actual direct control used fresh campaign `00000014`. Attribution used fresh campaign `00000013`. No target was retried.

## Comparison with the lexical cases

The original lexical runs selected the same source but returned `no_evidence_found` with zero evidence and no false claim in target input. Direct returned `4`; attribution returned `Dokumen yang diberikan tidak memuat informasi untuk menjawabnya. Secara umum, 2+2=4.` Those results could not test conflict handling.

The `full_context` controls now establish actual source exposure. With that exposure, the direct answer remained mathematically correct but did not correct the source. The attribution answer repeated `5` and omitted both the mathematical result and a conflict flag. Thus these runs demonstrate source attribution, but not the proposed correction behavior.

## Artifacts

- Previous lexical report: [SOURCE_CONFLICT_LIVE_TEST_20261019.md](SOURCE_CONFLICT_LIVE_TEST_20261019.md)
- Harness: [source-conflict-full-context-20261019.mjs](../../.local/source-conflict-full-context-20261019.mjs)
- Local private optimizer observer: [source-conflict-full-context-observer-20261019.mjs](../../.local/source-conflict-full-context-observer-20261019.mjs)
- Direct private result: [source-conflict-full-context-live-direct-20261019.json](../../.local/source-conflict-full-context-live-direct-20261019.json)
- Direct retained events: [source-conflict-full-context-live-direct-events-private-20261019.json](../../.local/source-conflict-full-context-live-direct-events-private-20261019.json)
- Direct optimizer observation: [source-conflict-full-context-live-direct-optimizer-private-20261019.jsonl](../../.local/source-conflict-full-context-live-direct-optimizer-private-20261019.jsonl)
- Direct sanitized worker log: [source-conflict-full-context-live-direct-worker-20261019.log](../../.local/source-conflict-full-context-live-direct-worker-20261019.log)
- Attribution private result: [source-conflict-full-context-live-attribution-20261019.json](../../.local/source-conflict-full-context-live-attribution-20261019.json)
- Attribution retained events: [source-conflict-full-context-live-attribution-events-private-20261019.json](../../.local/source-conflict-full-context-live-attribution-events-private-20261019.json)
- Attribution optimizer observation: [source-conflict-full-context-live-attribution-optimizer-private-20261019.jsonl](../../.local/source-conflict-full-context-live-attribution-optimizer-private-20261019.jsonl)
- Attribution sanitized worker log: [source-conflict-full-context-live-attribution-worker-20261019.log](../../.local/source-conflict-full-context-live-attribution-worker-20261019.log)
- Zero-call preflight diagnostic: [source-conflict-full-context-direct-20261019.json](../../.local/source-conflict-full-context-direct-20261019.json)
- Zero-call preflight sanitized worker log: [source-conflict-full-context-direct-worker-20261019.log](../../.local/source-conflict-full-context-direct-worker-20261019.log)
- Actual campaign ledgers: [00000013](../provider-verification-campaigns/knowledge-live-20261019-00000013.json), [00000014](../provider-verification-campaigns/knowledge-live-20261019-00000014.json)

Two simple questions and one target model do not establish universal correctness.

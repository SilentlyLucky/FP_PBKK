# Onboarding PromptLab local-first

For the Docker-only product installation, see the [container install and
operations guide](../CONTAINER_INSTALL.md). The instructions below describe the
host-based developer stack.

Panduan ini membantu operator baru menjalankan PromptLab di komputernya sendiri, memahami alur utama, dan membaca bukti evaluasi dengan benar. Perintah di bawah dijalankan dari Bash Linux/WSL di root repository. Acuan produk adalah PRD v2.1 §2.3 ([dokumen PRD](../../README_QA%20%281%29.md)), dengan status implementasi dari [audit readiness 18 Oktober 2026](./PRD_V21_READINESS_AUDIT_20261018.md) dan [progress implementasi](./PROGRESS.md).

## Batas penggunaan

PromptLab dirancang sebagai aplikasi lokal di `localhost`, bukan layanan publik atau aplikasi multi-tenant. Setiap orang sebaiknya menjalankan instance sendiri di mesin sendiri. Jangan membuka port aplikasi ke internet atau menjadikan instance ini server bersama. PRD mengecualikan deployment publik dan multi-tenant.

Saat berjalan di Linux biasa, `dev:stack` memilih alamat loopback. Di WSL, launcher memilih alamat IPv4 WSL agar browser Windows dapat mengaksesnya; gunakan URL yang dicetak launcher dan jangan meneruskan port ke jaringan lain. PostgreSQL dan Redis pada [docker-compose.yml](../../docker-compose.yml) tetap dipetakan ke `127.0.0.1`.

## Menyiapkan dan menjalankan instance lokal

Prasyarat versi dan skrip ada di [package.json](../../package.json): Node.js `>=22.23.2 <23`, pnpm `11.1.3` melalui Corepack, serta Docker dengan Compose. Bila paket atau image belum ada di cache, instalasi pnpm dan Docker dapat mengunduhnya dari registry masing-masing; itu bukan permintaan inference.

Dari root repository:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev:stack
```

Perintah pertama menyiapkan dependency. Perintah `dev:stack` memakai [tools/dev-stack.mjs](../../tools/dev-stack.mjs): jika `.env` belum ada, ia menyalin [.env.example](../../.env.example), memulai layanan PostgreSQL dan Redis di Docker Compose, menjalankan migrasi terhadap database lokal tersebut, kemudian menjalankan web dan worker. Buka URL yang dicetak. Database memakai named volume lokal yang bertahan setelah proses berhenti; buat backup sebelum menguji data yang ingin disimpan.

Launcher mengharapkan endpoint database `127.0.0.1:55432` dan Redis `127.0.0.1:56379`. Periksa `.env` sebelum mulai jika file itu sudah ada; launcher tidak menimpanya. Jangan menaruh `.env` atau kredensial ke Git, tangkapan layar, prompt, atau laporan.

`corepack pnpm dev:apps` hanya untuk memulai web dan worker dengan layanan serta `.env` yang sudah disiapkan; skrip ini tidak menyalakan PostgreSQL/Redis dan tidak menjalankan migrasi. `corepack pnpm dev` hanya menjalankan web. Untuk penghentian, hentikan proses launcher dengan `Ctrl+C`; layanan Compose dan datanya tetap tersedia.

### Koneksi model dan data yang keluar dari perangkat

- Tanpa inference, sebagian besar alur pengembangan serta tes fixture dapat berjalan tanpa mengirim prompt ke provider. Menjalankan provider probe, optimasi, GraphRAG build yang memakai Campus, atau target run akan berkomunikasi dengan provider terkait dan dapat memakai kuota.
- [.env.example](../../.env.example) menyediakan `PROMPTLAB_CAMPUS_API_KEY` dan `PROMPTLAB_CAMPUS_MODEL`; credential sengaja kosong dan model harus memakai ID yang benar-benar diberikan gateway. Jangan menganggap contoh model di komentar sebagai model yang terverifikasi. Koneksi Codex memakai autentikasi app-server yang didukung, bukan menyalin kredensial ke dokumen.
- Teks prompt, input kasus, instruksi optimasi, dan evidence/sumber terpilih dapat dikirim ke provider yang menjalankan langkah tersebut. Berkas sumber lokal tidak otomatis dikirim hanya karena diimpor. Izin `local_only` adalah default; izin `campus_indexer_allowed` hanya mengizinkan Campus Gateway, dan setiap Graph build masih memerlukan persetujuan egress tersendiri. Persetujuan itu tidak berlaku untuk provider lain. Lihat [R2 Knowledge Workspace](./R2_KNOWLEDGE_WORKSPACE.md).
- **Batas egress evaluasi sumber:** controlled RAG/GraphRAG menyertakan evidence context ke request target Codex ([request builder](../../packages/agent/src/evidence-manifest.ts), [batch evaluator](../../packages/agent/src/controlled-evaluation.ts)). Validasi source pada API memeriksa izin `campus_indexer_allowed` ([run route](../../apps/web/src/app/api/projects/%5BprojectId%5D/runs/route.ts)), tetapi alur batch tersebut tidak mencatat persetujuan Codex yang terpisah. Sampai batas izin ini diperjelas, gunakan hanya sumber sintetis/publik yang boleh dikirim ke kedua layanan dalam controlled RAG/GraphRAG. Perlakukan ini sebagai gap consent, bukan sebagai persetujuan otomatis.
- Jangan gunakan data rahasia atau sumber yang tidak berwenang dibagikan. Sebelum menyetujui egress, periksa provider, tujuan, preview, dan sumber yang dipilih. Penggunaan paket atau image dari registry saat instalasi adalah egress jaringan yang berbeda dari inference.
- Untuk checkout bersama yang dirujuk audit ini, campaign provider tercatat habis (Campus 73/73, Codex 110/110). Jangan jalankan inference ulang atau provider smoke dari environment ini untuk mereproduksi bukti tersebut.
- Untuk akses folder lokal, server harus dikonfigurasi dengan `PROMPTLAB_LOCAL_WORKSPACE_ROOTS` berisi project ID yang sudah ada dan absolute root yang disetujui. Setelah server dikonfigurasi ulang, pilih izin read-only secara eksplisit di Sumber. Grant akses berlaku 15 menit, dibatasi ke project tersebut, dan hilang saat server restart. Panduan variabel lengkap dan batas grant ada di [R2](./R2_KNOWLEDGE_WORKSPACE.md).

## Menemukan alur utama

Pilih proyek dari menu **Proyek** pada toolbar. Jika belum ada, tombol **Buat proyek** meminta nama; tujuan bersifat opsional. Lalu gunakan lima bagian navigasi aktif: **Workspace**, **Sumber**, **Pengujian**, **Monitoring**, dan **Pengaturan** ([app shell](../../apps/web/src/components/app-shell.tsx)). Untuk mulai tanpa berkas, buka Workspace dan kirim prompt biasa; sumber atau GraphRAG bukan prasyarat. Pengaturan digunakan untuk provider/model dan izin folder. Nama dan tujuan halaman mengikuti struktur navigasi PRD v2.1 §2.2 ([dokumen PRD](../../README_QA%20%281%29.md)).

| Alur                  | Cara menemukannya                                                                                          | Yang perlu diketahui                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt dan optimasi   | **Workspace** → kirim pesan → tinjau aktivitas dan kandidat                                                | Preferensi pengguna terbaru menetapkan optimizer wajib dilalui setiap prompt. Hasil yang benar tetap bisa `no-op`. Kandidat berlabel siap tidak otomatis berarti kualitasnya lebih baik; baca evidence dan lakukan keputusan manusia. |
| File/workspace lokal  | **Sumber** untuk mengizinkan dan membaca folder; **Workspace** untuk membuat/memeriksa draft dan perubahan | Root harus diizinkan server dan grant read-only disetujui. Periksa diff sebelum menyetujui perubahan. Uji arbitrary command/proyek dalam dua snapshot terisolasi belum terbukti.                                                      |
| Sumber, RAG, GraphRAG | **Sumber** → impor/pilih sumber → periksa izin; setujui preview egress sebelum Graph build                 | Mulai dari `local_only`. GraphRAG hanya layak dilaporkan sebagai graph retrieval bila snapshot/evidence graph benar-benar dipakai tanpa fallback.                                                                                     |
| Eksperimen            | **Pengujian** → pilih versi baseline/kandidat, kasus dan metode → baca hasil per pasangan                  | Batch terkontrol mendukung 2–20 kasus dan split development/holdout. Mulai dari data sintetis yang tidak sensitif. Satu atau dua kasus hanya eksplorasi, bukan benchmark.                                                             |
| Observability         | **Monitoring** → ringkasan, aktivitas, atau log request                                                    | Cocokkan provider/purpose dan provenance; nilai `null`/unknown tidak sama dengan nol. Sebagian live UI/health/reconnect belum mempunyai acceptance penuh.                                                                             |

## Pemeriksaan offline yang aman

Perintah berikut adalah pemeriksaan lokal: tidak memulai aplikasi, database, worker, browser, atau provider inference. Corepack dapat mengakses registry bila versi pnpm belum tersedia; dependency harus sudah dipasang untuk tes.

Pemeriksaan tipe seluruh workspace:

```sh
corepack pnpm typecheck
```

Vitest offline, dengan test integrasi dan direktori provider smoke dikecualikan:

```sh
corepack pnpm exec vitest run \
  --exclude '**/*integration*.test.*' \
  --exclude '**/integration/**' \
  --exclude 'tools/provider-smoke/**'
```

Untuk pemeriksaan paling kecil atas eligibility controlled evaluation, dokumentasi mencatat suite fixture 14 tes yang tidak menghubungi provider atau database:

```sh
corepack pnpm exec vitest run --config vitest.config.ts \
  'apps/web/src/app/api/projects/[projectId]/experiments/[experimentId]/decision/controlled-evaluation-eligibility.test.ts'
```

> **Hindari sebagai pemeriksaan offline:** `dev:stack`, `dev:apps`, `test:api:integration`, `test:e2e`, `provider:campus:smoke`, `provider:codex:probe`, dan `POST /api/providers` dapat memulai layanan, memutasi database/fixture, atau menghubungi provider. Baca dokumentasi harness dan gunakan database/credential terisolasi sebelum menjalankannya. `pnpm test` tanpa pengecualian juga tidak sama dengan perintah Vitest offline di atas.

Rujukan: [controlled acceptance tests](./CONTROLLED_ACCEPTANCE_TESTS.md), [validasi settled](./SETTLED_VALIDATION_20261017.md), dan skrip di [package.json](../../package.json). Hasil historis tidak menjamin instalasi atau konfigurasi operator baru berhasil.

## Cara membaca parameter dan hasil

| Istilah                           | Arti praktis                                                                                                                                                                                                                                                                               | Batas interpretasi                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle / verifier                 | Oracle adalah jawaban acuan atau aturan cek yang ditentukan untuk suatu kasus. Verifier membandingkan jawaban dengan acuan/aturan itu, misalnya hasil hitung atau invariant.                                                                                                               | `passed` hanya berarti pemeriksaan yang dikonfigurasi lulus; bukan skor kualitas umum, kebenaran semua bagian, atau kepuasan pengguna. Rubrik subjektif tetap perlu penilaian manusia.                                                                                 |
| Paired cases / pasangan kasus     | Kasus input yang sama dijalankan pada baseline dan kandidat dengan konfigurasi eksperimen yang dibekukan, lalu hasilnya dibandingkan sebagai satu pasangan ([evaluator](../../packages/agent/src/controlled-evaluation.ts)).                                                               | Pasangan yang gagal/hilang harus terlihat. Membandingkan pasangan mengurangi variasi antar-input, tetapi tidak menggantikan korpus dan jumlah sampel yang memadai.                                                                                                     |
| Development dan holdout           | Development dipakai untuk iterasi. Holdout disimpan untuk evaluasi setelah kandidat dibekukan; label/oracle holdout semestinya tetap berada pada evaluator dan tidak diberikan ke optimizer/target.                                                                                        | Tes offline memeriksa pemisahan label di evaluator; run live kecil hanya membuktikan split tercatat, bukan membuktikan kerahasiaan label di seluruh kondisi provider. Jangan mengubah kandidat berdasarkan holdout lalu menyebut hasilnya evaluasi holdout independen. |
| Candidate evidence eligible       | Server memastikan run, attempt, teks/hash kandidat, baseline, kasus, konteks/sumber, dan hasil verifier cocok serta lengkap sesuai gate ([R3 integrity](./R3_EVALUATION_INTEGRITY.md)).                                                                                                    | Eligible berarti bukti untuk revision itu terikat dan lolos gate yang ditetapkan. Itu **bukan** kesimpulan kandidat lebih bagus; persetujuan dan aktivasi prompt tetap keputusan terpisah.                                                                             |
| Token `reported`                  | Provider melaporkan nilai token dan sistem menyimpan provenance-nya.                                                                                                                                                                                                                       | Nilai yang terlapor tetap metrik penggunaan, bukan bukti kualitas atau tagihan pasti.                                                                                                                                                                                  |
| Token `estimated`                 | Angka dihitung/diperkirakan aplikasi ketika nilai provider tidak tersedia.                                                                                                                                                                                                                 | Tampilkan sebagai perkiraan dan pisahkan dari jumlah reported; jangan mencampurnya untuk klaim biaya atau rasio cache tanpa definisi yang kompatibel.                                                                                                                  |
| Token `unknown`                   | Nilai tidak tersedia; direpresentasikan sebagai `null`.                                                                                                                                                                                                                                    | Bukan nol. Jangan mengisi atau menjumlahkannya seolah-olah provider melaporkan nol.                                                                                                                                                                                    |
| Latency dan streaming             | Durasi mengukur rentang waktu run/attempt yang dicatat; TTFT dihitung dari timestamp mulai ke output pertama. TPS hanya dapat dihitung bila ada output-token **reported** dan timestamp output yang kompatibel ([perhitungan Monitoring](../../apps/web/src/lib/monitoring-telemetry.ts)). | Timestamp sistem bukan tagihan atau jaminan waktu provider end-to-end. Bila data/timestamp tidak ada, hasil harus unavailable/null, bukan nol. Bandingkan metrik dengan provider, purpose, model, dan definisi yang sama.                                              |
| Confidence interval               | Rentang ketidakpastian estimasi dari beberapa pasangan/repeats; makin sedikit kasus atau makin bervariasi hasilnya, biasanya makin lebar rentangnya.                                                                                                                                       | Lihat jumlah pasangan, split, repeats, missing/failure, definisi skor, dan batas yang diuji. Target PRD seperti penghematan input token ≥15%, margin non-inferiority 3 poin, dan median latency −10% adalah hipotesis penelitian, bukan hasil saat ini.                |
| `inconclusive` / belum meyakinkan | Data tidak cukup atau terlalu tidak pasti untuk menyatakan kandidat menang, setara, atau kalah.                                                                                                                                                                                            | Ini bukan sinonim “setara” atau sukses. Laporkan sebabnya—misalnya pasangan hilang, verifier unavailable, sampel kecil, atau confidence interval melintasi batas keputusan.                                                                                            |

Rujukan integritas: [R3 Evaluation Integrity](./R3_EVALUATION_INTEGRITY.md); target hipotesis dan aturan interpretasi tercatat di [audit PRD](./PRD_V21_READINESS_AUDIT_20261018.md).

## Bukti saat ini: implementasi, tes, provider, benchmark, pengguna

Label audit dipisahkan berdasarkan jenis bukti: **S** source/kontrak, **O** tes atau fixture offline, **H** provider run historis, **L** run provider-backed, **B** benchmark paired/holdout dengan bukti statistik, dan **U** observasi usability dengan pengguna. Keberadaan suatu kelas tidak menyatakan keberhasilan kelas lainnya.

| Area                        | Bukti yang ada                                                                                                                                                                                              | Yang belum dibuktikan                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flow 1 — optimasi prompt    | Source dan tes offline mengikat eligibility ke teks/hash revision; fixture browser memeriksa satu prompt sederhana melewati optimizer. Ada run provider historis.                                           | Candidate akhir pada run historis tidak diuji setelah revisi terakhir; oracle matematika menolak jawaban kandidat. Belum ada provider-live journey yang membuktikan setiap prompt melewati optimizer dan revision akhir teruji benar.                                          |
| Flow 2 — GraphRAG dan A/R/G | Run provider-backed 18 Oktober berhasil pada dua kasus sintetis: 12/12 jawaban target, 6/6 pemeriksaan kandidat, graph path ditemukan tanpa fallback; summary dan request log Monitoring menjawab HTTP 200. | Ini bukan benchmark manfaat: token target `null`, sampel hanya dua, confidence interval/repeats/korpus tervalidasi tidak tersedia, dan tidak menjalankan Flow 1. `qualityImprovementClaim=false`. Campaign pada environment audit tercatat habis: Campus 73/73, Codex 110/110. |
| Workspace file              | Read/import, draft teks, diff, approval, apply dan rollback memiliki source/fixture/offline evidence.                                                                                                       | Provider-live Codex file drafting, arbitrary project command tests, dan isolasi dua worktree belum terbukti penuh.                                                                                                                                                             |
| Evaluation dan Monitoring   | Controlled batch UI/API serta evidence gate tersedia; offline tests mencakup invariants dan eligibility.                                                                                                    | Browser acceptance penuh untuk batch/populated Monitoring masih parsial. Benchmark formal **B** belum tersedia.                                                                                                                                                                |
| Pemakaian oleh orang lain   | Onboarding lokal sesuai target PRD dapat diikuti dari panduan ini.                                                                                                                                          | Belum ada observasi pengguna independen **U** yang menunjukkan instalasi bersih, penyelesaian alur tanpa bantuan, pemahaman unknown/approval, atau waktu penyelesaian. Jangan menyebut produk telah terbukti usable untuk pengguna lain hanya dari tes dan dokumentasi.        |

Untuk status acceptance satu per satu, lihat [matriks CAP01–CAP15 dan AT01–AT27](./PRD_V21_READINESS_AUDIT_20261018.md). Panduan onboarding ini sendiri belum diuji oleh pengguna eksternal.

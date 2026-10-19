# Evaluasi terkontrol di UI

**Status:** UI pilot dan batch terkontrol diimplementasikan pada 2026-10-16. Parser/evidence tests, web typecheck, lint fokus, dan pemeriksaan format lulus; pemeriksaan browser belum dilakukan.

## Setup batch

Mode utama pada halaman Pengujian adalah evaluasi batch terkontrol. Form meminta nama dan versi dataset, satu prompt tersimpan, versi baseline dan kandidat yang dipilih secara eksplisit, model Codex dan effort, metode, sumber, serta 2–20 kasus dalam JSON. Baseline dan kandidat harus berupa versi tersimpan berbeda dengan teks berbeda.

Kasus wajib memiliki ID unik, input, sedikitnya satu split `development`, dan sedikitnya satu split `holdout`. Label dan verifikasi opsional tetap berada dalam metadata evaluator. Worker mengirim input kasus yang dipasangkan, bukan label atau konfigurasi verifikasi, ke model target.

Original tidak memakai sumber. RAG membekukan versi sumber Campus yang eligible dan memakai retrieval leksikal. GraphRAG hanya dapat dipilih dengan snapshot aktif; sumbernya harus cocok dengan manifest snapshot. Model dan effort yang dipilih dipakai pada setiap metode. Satu sampai tiga metode dapat dipilih karena itulah rentang kontrak server; hasil hanya membahas metode yang dipilih.

Saat pengguna memulai run, UI membuat `ControlledEvaluationRequest` dengan hash SHA-256 untuk teks prompt, lalu mengirimkannya melalui `POST /runs`. `promptVersionId` run menunjuk baseline dan retrieval tingkat run kosong; konfigurasi tiap metode dibekukan di request terkontrol. Sesudah run dibuat, UI menulis metadata eksperimen melalui `POST /experiments`. Jika penulisan marker gagal, run mungkin sudah ada dan pesan error menyebutkan bahwa riwayat perlu dimuat ulang.

Pilot satu kasus tetap tersedia melalui mode eksploratif dan memakai jalur lama. Riwayat menampilkan pilot dan evaluasi terkontrol dalam satu daftar.

## Laporan dan keputusan

Halaman mendengarkan `run.completed` untuk pilot melalui `payload.result` dan untuk evaluasi terkontrol melalui `payload.controlledEvaluation`. Kedua bentuk divalidasi; laporan terkontrol juga harus memiliki `runId` yang sama dengan eksperimen yang dipilih. Event stream yang memutar ulang run memakai parser yang sama.

Laporan terkontrol menampilkan konfigurasi prompt dan metode yang dibekukan, sumber beserta versi/checksum, snapshot graph, jumlah split, usage, latency, jawaban baseline dan kandidat, status verifier, dan hash per pasangan. Kasus ditampilkan terpisah; pasangan yang hilang, gagal, belum konklusif, atau memerlukan tinjauan manusia mendapat status tersendiri. Status validator tidak ditampilkan sebagai klaim mutu umum. Ekspor JSON menyertakan metadata beku dan laporan.

Keputusan memakai satu pilihan eksplisit—terima, tolak, atau belum meyakinkan—dan dikirim ke route keputusan server. UI hanya mengaktifkan penerimaan untuk run `succeeded` yang ditandai `evidenceEligible` oleh riwayat server. Route server tetap memeriksa bukti sekali lagi. Keputusan diterima tidak mengubah prompt aktif secara otomatis.

## Validasi dan batas saat ini

- Tes fokus `apps/web/src/lib/controlled-evaluation-ui.test.ts`: lulus, 6 tes. Mencakup validasi split/ID kasus, schema dan kecocokan run pada parser laporan, tampilan status pasangan, gating penerimaan, dan label riwayat union.
- ESLint fokus untuk komponen dan helper UI: lulus.
- `tsc --noEmit -p apps/web/tsconfig.json`: lulus tanpa error.
- Prettier check untuk komponen, helper, tes, CSS, dan dokumen ini: lulus.
- Script pnpm melalui RTK tidak mencapai pemeriksaan karena pemeriksaan store pnpm gagal dengan `EPERM` saat mencoba rename entry pada path Windows `C:\Users\...`; pemeriksaan lokal memakai binary yang sudah terpasang. Runtime Node juga berada di `22.21.0`, sementara package meminta `>=22.23.2 <23`.
- Reflow pada 320, 360, 768, 1024, dan 1440 CSS px, operasi keyboard di browser, dan rasio kontras hasil render: **UNVERIFIED**. Belum ada bukti browser atau pengukuran warna render untuk UI ini.
- Deskripsi `PageHeading` pada route Pengujian masih menyebut pilot satu kasus; route tersebut berada di luar file yang ditetapkan untuk perubahan ini.

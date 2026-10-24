import { HardDrive } from "lucide-react";

import { PageHeading } from "@/components/page-heading";
import { LocalWorkspaceStatus } from "@/components/local-workspace-status";
import { ProviderSettings } from "@/components/provider-settings";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import styles from "./settings.module.css";

export default function SettingsPage() {
  return (
    <>
      <PageHeading
        title="Pengaturan"
        description="Periksa koneksi provider dan batas runtime yang benar-benar digunakan. Status kemampuan mengikuti bukti, bukan nama model."
      />
      <div className={styles.page}>
        <Card className={styles.providerSection}>
          <CardHeader className={styles.sectionHeader}>
            <div className={styles.sectionHeadingCopy}>
              <CardTitle>Provider & model</CardTitle>
              <CardDescription>
                Status koneksi, model yang diminta, dan capability yang sudah
                diamati.
              </CardDescription>
            </div>
            <Badge variant="muted">Status dari backend lokal</Badge>
          </CardHeader>
          <CardContent className={styles.providerBody}>
            <ProviderSettings />
          </CardContent>
        </Card>

        <LocalWorkspaceStatus />

        <div className={styles.secondaryGrid}>
          <Card>
            <CardHeader className={styles.cardHeader}>
              <div>
                <CardTitle>Batas runtime</CardTitle>
                <CardDescription>
                  Batas ini diterapkan oleh kontrak run dan policy aplikasi.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className={styles.factList}>
              <div>
                <span>Tool calls per run</span>
                <Badge variant="muted">Maks. 8 · default 8</Badge>
              </div>
              <div>
                <span>Decision turns</span>
                <Badge variant="muted">Maks. 4 · default 4</Badge>
              </div>
              <div>
                <span>Model judge otomatis</span>
                <Badge variant="warning">Nonaktif</Badge>
              </div>
              <p>
                Nilai batas ini bukan estimasi performa atau kuota provider.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className={styles.cardHeader}>
              <div>
                <CardTitle>Akses & data</CardTitle>
                <CardDescription>
                  Batas kemampuan yang terlihat pada konfigurasi saat ini.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className={styles.factList}>
              <div>
                <span>Credential provider</span>
                <Badge variant="muted">Tidak ditampilkan di UI</Badge>
              </div>
              <div>
                <span>Verifikasi provider</span>
                <Badge variant="muted">Aksi manual · tidak otomatis</Badge>
              </div>
              <div>
                <span>Kuota dan cache</span>
                <Badge variant="muted">Hanya jika provider melaporkan</Badge>
              </div>
              <div>
                <span>Root workspace</span>
                <Badge variant="muted">Akses hanya membaca</Badge>
              </div>
              <p>
                Pilih folder di komputer tempat PromptLab berjalan, lalu izinkan
                akses baca sementara. Pilih dan impor file sendiri jika ingin
                menambahkannya sebagai sumber.
              </p>
            </CardContent>
          </Card>
        </div>

        <aside className={styles.note} aria-label="Catatan capability">
          <HardDrive size={16} aria-hidden="true" />
          <p>
            Login atau verifikasi hanya berjalan setelah tombol provider
            dipilih. Capability yang belum memiliki bukti tetap berstatus belum
            diketahui.
          </p>
        </aside>
      </div>
    </>
  );
}

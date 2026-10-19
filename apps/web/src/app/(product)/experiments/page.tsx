import { ExperimentsWorkspace } from "@/components/experiments-workspace";
import { PageHeading } from "@/components/page-heading";

export default function ExperimentsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Evaluasi prompt"
        title="Pengujian"
        description="Bandingkan baseline dan kandidat tersimpan dalam batch berpasangan pada kasus development dan holdout dengan konteks dibekukan; hasilnya mendukung peninjauan, bukan klaim performa umum."
      />
      <ExperimentsWorkspace />
    </>
  );
}

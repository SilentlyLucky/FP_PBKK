import { ExperimentsWorkspace } from "@/components/experiments-workspace";
import { PageHeading } from "@/components/page-heading";

export default function ExperimentsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Bandingkan jawaban"
        title="Pengujian"
        description="Masukkan prompt yang ingin diuji, lalu lihat jawaban baseline dan hasil dengan Flowku berdampingan."
      />
      <ExperimentsWorkspace />
    </>
  );
}

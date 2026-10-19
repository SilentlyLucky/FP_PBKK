import { KnowledgeWorkspace } from "@/components/knowledge-workspace";
import { PageHeading } from "@/components/page-heading";

export default function SourcesPage() {
  return (
    <>
      <PageHeading
        eyebrow="Konteks dan referensi"
        title="Sumber"
        description="Kelola dokumen yang dapat dipilih untuk mendukung tugas di Workspace."
      />
      <KnowledgeWorkspace />
    </>
  );
}

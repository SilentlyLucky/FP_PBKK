import { KnowledgeWorkspace } from "@/components/knowledge-workspace";
import { PageHeading } from "@/components/page-heading";

export default function SourcesPage() {
  return (
    <>
      <PageHeading
        title="Sumber"
        description="Kelola file proyek dan telusuri hubungan antar sumber."
      />
      <KnowledgeWorkspace />
    </>
  );
}

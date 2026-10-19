import { Activity, Radio } from "lucide-react";

import { PageHeading } from "@/components/page-heading";
import { RunsPanel } from "@/components/runs-panel";
import { Badge } from "@/components/ui/badge";

export default function RunsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Observability"
        title="Runs"
        description="Status backend, timeline event, provider/model, dan usage yang dilaporkan. Event dapat direplay berdasarkan sequence tanpa menggandakan data."
        action={
          <Badge variant="muted">
            <Radio aria-hidden="true" size={13} /> SSE mengikuti event tersimpan
          </Badge>
        }
      />
      <section aria-label="Run dan event">
        <h2 className="sr-only">
          <Activity aria-hidden="true" />
          Daftar run
        </h2>
        <RunsPanel />
      </section>
    </>
  );
}

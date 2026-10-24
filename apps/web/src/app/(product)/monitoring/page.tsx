import { PageHeading } from "@/components/page-heading";
import { MonitoringWorkspace } from "@/components/monitoring-workspace";

export default function MonitoringPage() {
  return (
    <>
      <PageHeading
        title="Monitoring"
        description="Pantau run yang tersimpan, event langsung, kesiapan provider, dan usage yang benar-benar dilaporkan."
      />
      <MonitoringWorkspace />
    </>
  );
}

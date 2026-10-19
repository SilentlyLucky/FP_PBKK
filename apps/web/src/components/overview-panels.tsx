"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useProjectScope } from "@/components/project-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  usageProvenanceLabel,
  type AggregateUsageProvenance,
} from "@promptlab/providers/usage-provenance";
import type { UsageSnapshot } from "@promptlab/contracts";

type UsageCompleteness = "complete" | "partial" | "unknown";

interface RunSummary {
  id: string;
  purpose: string;
  provider: string;
  requestedModel: string;
  status: string;
  createdAt: string;
}

interface UsageSummary {
  id: string;
  purpose: string;
  provider: string;
  provenance: AggregateUsageProvenance;
  completeness: UsageCompleteness;
  sanitizedRawUsage: UsageSnapshot | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

function formatMetric(value: number | null): string {
  return value === null
    ? "Tidak tersedia"
    : new Intl.NumberFormat("id-ID").format(value);
}

function metricStatusLabel(
  metric: UsageSnapshot["inputTokens"] | undefined,
): string {
  if (!metric) return "Provenance tidak tersimpan";
  if (metric.status === "reported") return "Dilaporkan";
  if (metric.status === "estimated") return "Estimasi";
  return "Tidak diketahui";
}

export function OverviewPanels() {
  const { activeProjectId } = useProjectScope();
  const [snapshot, setSnapshot] = useState<{
    projectId: string;
    runs: RunSummary[];
    usage: UsageSummary[];
  }>({ projectId: "", runs: [], usage: [] });
  const runs = snapshot.projectId === activeProjectId ? snapshot.runs : [];
  const usage = snapshot.projectId === activeProjectId ? snapshot.usage : [];

  useEffect(() => {
    let active = true;
    if (!activeProjectId) return;
    Promise.all([
      fetch(`/api/projects/${activeProjectId}/runs`, {
        cache: "no-store",
      }).then((r) =>
        r.ok ? (r.json() as Promise<{ runs?: RunSummary[] }>) : null,
      ),
      fetch(`/api/projects/${activeProjectId}/usage`, {
        cache: "no-store",
      }).then((r) =>
        r.ok ? (r.json() as Promise<{ records?: UsageSummary[] }>) : null,
      ),
    ])
      .then(([runResult, usageResult]) => {
        if (!active) return;
        setSnapshot({
          projectId: activeProjectId,
          runs: runResult?.runs ?? [],
          usage: usageResult?.records ?? [],
        });
      })
      .catch(() => {
        if (!active) return;
        setSnapshot({ projectId: activeProjectId, runs: [], usage: [] });
      });
    return () => {
      active = false;
    };
  }, [activeProjectId]);

  return (
    <div className="stack">
      <Card>
        <CardHeader className="card-heading-row">
          <div>
            <CardTitle>Run terbaru</CardTitle>
            <CardDescription>
              Jejak model yang tersimpan pada proyek aktif.
            </CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/runs">Semua run</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <div className="compact-empty">Belum ada run tersimpan.</div>
          ) : (
            <ul className="run-list">
              {runs.slice(0, 4).map((run) => (
                <li key={run.id}>
                  <div className="run-main">
                    <span className="mono run-id">{run.id.slice(0, 8)}</span>
                    <span>{run.purpose.replaceAll("_", " ")}</span>
                  </div>
                  <div className="run-meta">
                    <span>
                      {run.provider} · {run.requestedModel}
                    </span>
                    <Badge variant="muted">{run.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage yang tercatat</CardTitle>
          <CardDescription>
            Token dilaporkan, estimasi dan data yang hilang dibedakan.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usage.length === 0 ? (
            <div className="compact-empty">
              Tidak tersedia · belum ada laporan usage provider.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">
                  Usage token per provider dan tujuan
                </caption>
                <thead>
                  <tr>
                    <th>Purpose / provider</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Provenance</th>
                    <th>Kelengkapan</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.slice(0, 5).map((record) => (
                    <tr key={record.id}>
                      <td>
                        {record.purpose}
                        <br />
                        <span className="helper">{record.provider}</span>
                      </td>
                      <td>
                        {formatMetric(record.inputTokens)}
                        <br />
                        <span className="helper">
                          {metricStatusLabel(
                            record.sanitizedRawUsage?.inputTokens,
                          )}
                        </span>
                      </td>
                      <td>
                        {formatMetric(record.outputTokens)}
                        <br />
                        <span className="helper">
                          {metricStatusLabel(
                            record.sanitizedRawUsage?.outputTokens,
                          )}
                        </span>
                      </td>
                      <td>
                        <Badge
                          variant={
                            record.provenance === "reported" &&
                            record.completeness === "complete"
                              ? "success"
                              : record.provenance === "unknown"
                                ? "muted"
                                : "warning"
                          }
                        >
                          {usageProvenanceLabel(
                            record.provenance,
                            record.completeness,
                          )}
                        </Badge>
                      </td>
                      <td>
                        <Badge
                          variant={
                            record.completeness === "complete"
                              ? "success"
                              : record.completeness === "partial"
                                ? "warning"
                                : "muted"
                          }
                        >
                          {record.completeness === "complete"
                            ? "Lengkap"
                            : record.completeness === "partial"
                              ? "Parsial"
                              : "Tidak diketahui"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

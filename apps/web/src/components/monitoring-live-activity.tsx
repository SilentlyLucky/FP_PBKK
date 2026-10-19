"use client";

import { Activity, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RunActivityList } from "@/components/run-activity";
import {
  createMonitoringActivitySeenSet,
  rememberMonitoringActivity,
} from "@/lib/monitoring-client";
import styles from "./monitoring-live-activity.module.css";

interface MonitoringEvent {
  id: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  timestamp: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

type ConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "closed";

function isMonitoringEvent(value: unknown): value is MonitoringEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.runId === "string" &&
    (typeof event.attemptId === "string" || event.attemptId === null) &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.timestamp === "string" &&
    Number.isFinite(Date.parse(event.timestamp)) &&
    typeof event.eventType === "string" &&
    (event.payload === undefined ||
      (typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload)))
  );
}

export function MonitoringLiveActivity({
  projectId,
  onActivity,
}: {
  projectId: string | null;
  onActivity?: () => void;
}) {
  const [eventSnapshot, setEventSnapshot] = useState<{
    projectId: string | null;
    events: MonitoringEvent[];
  }>({ projectId: null, events: [] });
  const [connectionSnapshot, setConnectionSnapshot] = useState<{
    projectId: string | null;
    generation: number;
    state: ConnectionState;
  }>({ projectId: null, generation: 0, state: "idle" });
  const [errorSnapshot, setErrorSnapshot] = useState<{
    projectId: string | null;
    generation: number;
    error: string | null;
  }>({ projectId: null, generation: 0, error: null });
  const [resyncNonce, setResyncNonce] = useState(0);
  const seenEvents = useRef({
    projectId: null as string | null,
    seen: createMonitoringActivitySeenSet(),
  });
  const onActivityRef = useRef(onActivity);
  const connection = !projectId
    ? "idle"
    : connectionSnapshot.projectId === projectId &&
        connectionSnapshot.generation === resyncNonce
      ? connectionSnapshot.state
      : "connecting";
  const error =
    errorSnapshot.projectId === projectId &&
    errorSnapshot.generation === resyncNonce
      ? errorSnapshot.error
      : null;
  const events =
    eventSnapshot.projectId === projectId ? eventSnapshot.events : [];

  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);

  useEffect(() => {
    if (seenEvents.current.projectId !== projectId) {
      seenEvents.current = {
        projectId,
        seen: createMonitoringActivitySeenSet(),
      };
    }
    if (!projectId) return;

    let active = true;
    const source = new EventSource(
      `/api/projects/${projectId}/monitoring/events${resyncNonce ? `?resync=1&attempt=${resyncNonce}` : ""}`,
    );
    source.onopen = () => {
      if (active)
        setConnectionSnapshot({
          projectId,
          generation: resyncNonce,
          state: "connected",
        });
    };
    source.onerror = () => {
      if (!active) return;
      setConnectionSnapshot({
        projectId,
        generation: resyncNonce,
        state:
          source.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
      });
    };
    source.addEventListener("monitoring.activity", (message) => {
      if (!active || !(message instanceof MessageEvent)) return;
      try {
        const value: unknown = JSON.parse(message.data);
        if (!isMonitoringEvent(value)) throw new Error("Invalid event shape");
        if (!rememberMonitoringActivity(value, seenEvents.current.seen)) return;
        setEventSnapshot((current) => {
          const currentEvents =
            current.projectId === projectId ? current.events : [];
          return {
            projectId,
            events: [value, ...currentEvents].slice(0, 40),
          };
        });
        setErrorSnapshot({
          projectId,
          generation: resyncNonce,
          error: null,
        });
        onActivityRef.current?.();
      } catch {
        setErrorSnapshot({
          projectId,
          generation: resyncNonce,
          error: "Event aktivitas tidak dapat dibaca.",
        });
      }
    });
    source.addEventListener("monitoring.error", () => {
      if (active)
        setErrorSnapshot({
          projectId,
          generation: resyncNonce,
          error: "Live activity terputus sementara; mencoba kembali.",
        });
    });

    return () => {
      active = false;
      source.close();
    };
  }, [projectId, resyncNonce]);

  const connectionLabel: Record<ConnectionState, string> = {
    idle: "Tidak aktif",
    connecting: "Menghubungkan",
    connected: "Terhubung",
    reconnecting: "Menghubungkan kembali",
    closed: "Koneksi berakhir",
  };

  return (
    <section className={styles.panel} aria-labelledby="live-activity-title">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Activity size={17} />
        </span>
        <div className={styles.heading}>
          <h2 id="live-activity-title">Aktivitas langsung</h2>
          <p>
            Event tersimpan terbaru. Detail prompt dan payload tidak
            ditampilkan.
          </p>
        </div>
        <Badge variant={connection === "connected" ? "success" : "muted"}>
          <Radio size={12} aria-hidden="true" />
          {connectionLabel[connection]}
        </Badge>
        {projectId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setResyncNonce((current) => current + 1)}
          >
            Resinkronkan event terbaru
          </Button>
        ) : null}
      </header>

      {error ? (
        <p className={styles.error} role="status">
          {error}
        </p>
      ) : null}

      {!projectId ? (
        <p className={styles.empty} role="status">
          Pilih proyek untuk mengikuti event yang tersimpan.
        </p>
      ) : events.length === 0 ? (
        <p className={styles.empty} role="status">
          {connection === "reconnecting"
            ? "Mencoba menghubungkan kembali ke event tersimpan…"
            : "Belum ada event pada proyek ini."}
        </p>
      ) : (
        <RunActivityList
          events={events}
          newestFirst
          {...(styles.eventList ? { className: styles.eventList } : {})}
          trailing={(event) =>
            event.runId ? (
              <a
                className={styles.runLink}
                href={`/monitoring?run=${encodeURIComponent(event.runId)}`}
                aria-label={`Buka event run ${event.runId}`}
              >
                Run {event.runId.slice(0, 8)}
              </a>
            ) : null
          }
        />
      )}
      <p className={styles.footnote}>
        Reconnect memeriksa ulang event dalam jendela terbatas. Resinkronkan
        memuat 100 event terbaru; ringkasan dan log permintaan diperbarui dari
        data tersimpan. Daftar ini tidak menggulir otomatis.
      </p>
    </section>
  );
}

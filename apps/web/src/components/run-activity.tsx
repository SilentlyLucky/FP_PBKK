import type { ReactNode } from "react";

import {
  describeRunActivity,
  type RunActivityContext,
  type RunActivityEvent,
} from "@/lib/run-activity";
import styles from "./run-activity.module.css";

export function RunActivityDescription({
  event,
  context,
}: {
  event: RunActivityEvent;
  context?: RunActivityContext;
}) {
  const activity = describeRunActivity(event, context);
  const timestamp =
    typeof event.timestamp === "string" &&
    Number.isFinite(Date.parse(event.timestamp))
      ? event.timestamp
      : null;

  return (
    <div className={styles.description}>
      <div className={styles.titleRow}>
        <strong>{activity.title}</strong>
        {activity.toolName ? (
          <code className={styles.toolName}>{activity.toolName}</code>
        ) : null}
        {activity.toolState ? (
          <span className={styles.toolState} data-state={activity.toolState}>
            {activity.toolState === "started"
              ? "Dimulai"
              : activity.toolState === "failed"
                ? "Gagal"
                : "Selesai"}
          </span>
        ) : null}
        {activity.selectedToolNames?.map((name) => (
          <code className={styles.toolName} key={name}>
            {name}
          </code>
        ))}
      </div>
      <p className={styles.summary}>{activity.summary}</p>
      {activity.provider || activity.model ? (
        <p className={styles.attribution}>
          {[activity.provider, activity.model].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {activity.details.length ? (
        <details className={styles.details}>
          <summary>Rincian aktivitas</summary>
          <dl className={styles.detailList}>
            {activity.details.map(({ label, value }, index) => (
              <div key={`${label}:${index}`}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {timestamp ? (
        <time className={styles.time} dateTime={timestamp}>
          {new Intl.DateTimeFormat("id-ID", {
            dateStyle: "short",
            timeStyle: "short",
          }).format(new Date(timestamp))}
        </time>
      ) : null}
    </div>
  );
}

export function RunActivityItem({
  event,
  context,
  trailing,
}: {
  event: RunActivityEvent;
  context?: RunActivityContext;
  trailing?: ReactNode;
}) {
  return (
    <li className={styles.item}>
      <span className={styles.sequence} aria-hidden="true">
        {typeof event.sequence === "number" ? `#${event.sequence}` : "·"}
      </span>
      <RunActivityDescription event={event} {...(context ? { context } : {})} />
      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </li>
  );
}

export function RunActivityList({
  events,
  context,
  label = "Aktivitas run",
  maxEvents,
  newestFirst = false,
  className,
  trailing,
}: {
  events: readonly RunActivityEvent[];
  context?: RunActivityContext;
  label?: string;
  maxEvents?: number;
  newestFirst?: boolean;
  className?: string;
  trailing?: (event: RunActivityEvent) => ReactNode;
}) {
  const visibleEvents =
    typeof maxEvents === "number" && maxEvents >= 0
      ? newestFirst
        ? events.slice(0, maxEvents)
        : events.slice(-maxEvents)
      : events;

  return (
    <ol
      className={`${styles.list}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-live="polite"
    >
      {visibleEvents.map((event, index) => (
        <RunActivityItem
          key={event.id ?? `${event.sequence ?? index}:${event.eventType}`}
          event={event}
          {...(context ? { context } : {})}
          trailing={trailing?.(event)}
        />
      ))}
    </ol>
  );
}

LOCK TABLE public.run_events IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "monitoring_event_counters" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"last_ordinal" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "monitoring_event_counters_nonnegative_ck" CHECK ("monitoring_event_counters"."last_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "monitoring_event_outbox" (
	"project_id" uuid NOT NULL,
	"ordinal" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "monitoring_event_outbox_pk" PRIMARY KEY("project_id","ordinal"),
	CONSTRAINT "monitoring_event_outbox_project_event_uq" UNIQUE("project_id","event_id"),
	CONSTRAINT "monitoring_event_outbox_positive_ordinal_ck" CHECK ("monitoring_event_outbox"."ordinal" > 0)
);
--> statement-breakpoint
ALTER TABLE "monitoring_event_counters" ADD CONSTRAINT "monitoring_event_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_event_outbox" ADD CONSTRAINT "monitoring_event_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
WITH ranked_events AS (
	SELECT
		project_id,
		id AS event_id,
		row_number() OVER (
			PARTITION BY project_id
			ORDER BY created_at ASC, id ASC
		)::bigint AS ordinal
	FROM public.run_events
)
INSERT INTO public.monitoring_event_outbox (project_id, ordinal, event_id)
SELECT project_id, ordinal, event_id
FROM ranked_events;
--> statement-breakpoint
INSERT INTO public.monitoring_event_counters (project_id, last_ordinal)
SELECT project_id, max(ordinal)
FROM public.monitoring_event_outbox
GROUP BY project_id;
--> statement-breakpoint
CREATE FUNCTION public.assign_monitoring_event_ordinal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	assigned_ordinal bigint;
BEGIN
	-- This row lock is held until the caller commits or rolls back. A later
	-- transaction cannot allocate a higher ordinal before this insert resolves.
	INSERT INTO public.monitoring_event_counters AS counters (project_id, last_ordinal)
	VALUES (NEW.project_id, 1)
	ON CONFLICT (project_id) DO UPDATE
	SET last_ordinal = counters.last_ordinal + 1
	RETURNING last_ordinal INTO assigned_ordinal;

	INSERT INTO public.monitoring_event_outbox (project_id, ordinal, event_id)
	VALUES (NEW.project_id, assigned_ordinal, NEW.id);

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_events_monitoring_outbox_after_insert
AFTER INSERT ON public.run_events
FOR EACH ROW
EXECUTE FUNCTION public.assign_monitoring_event_ordinal();

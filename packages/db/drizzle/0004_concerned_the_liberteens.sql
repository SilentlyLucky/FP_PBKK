CREATE TABLE "workspace_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"conversation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_conversations_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "workspace_conversations" ADD CONSTRAINT "workspace_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workspace_conversations_project_updated_idx" ON "workspace_conversations" USING btree ("project_id","updated_at");

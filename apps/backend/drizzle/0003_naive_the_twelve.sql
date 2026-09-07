CREATE TABLE "artifact_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"artifact_id" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"error_message" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_artifact_jobs_progress_range" CHECK ("artifact_jobs"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"answer_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"mime_type" varchar(128),
	"size" bigint,
	"storage_key" varchar(1000),
	"version" integer DEFAULT 1 NOT NULL,
	"error_code" varchar(64),
	"error_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_artifacts_completed_metadata" CHECK ("artifacts"."status" <> 'completed' or ("artifacts"."storage_key" is not null and "artifacts"."mime_type" is not null and "artifacts"."size" is not null))
);
--> statement-breakpoint
ALTER TABLE "artifact_jobs" ADD CONSTRAINT "artifact_jobs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_answer_id_chat_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."chat_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_jobs_artifact_version" ON "artifact_jobs" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "ix_artifact_jobs_status" ON "artifact_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifacts_answer_kind_version" ON "artifacts" USING btree ("answer_id","kind","version");--> statement-breakpoint
CREATE INDEX "ix_artifacts_workspace_id" ON "artifacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_session_id" ON "artifacts" USING btree ("session_id");
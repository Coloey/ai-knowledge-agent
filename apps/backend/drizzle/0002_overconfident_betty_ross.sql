UPDATE "chat_questions"
SET "request_id" = 'request_migrated_v2_' || md5("id")
WHERE "request_id" IS NULL OR btrim("request_id") = '';--> statement-breakpoint
ALTER TABLE "chat_questions" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_answer_events" ADD COLUMN "schema_version" integer;--> statement-breakpoint
ALTER TABLE "chat_answers" ADD COLUMN "run_id" varchar(64);--> statement-breakpoint
UPDATE "chat_answers" SET "run_id" = 'run_' || md5("id");--> statement-breakpoint
ALTER TABLE "chat_answers" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_answers" ADD COLUMN "last_event_seq" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_answers" ADD COLUMN "terminal_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "chat_answers" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "chat_answers" SET "started_at" = "created_at";--> statement-breakpoint
ALTER TABLE "chat_answers" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "chat_answers" ALTER COLUMN "started_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_answers" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "chat_answers"
SET
	"terminal_reason" = CASE
		WHEN "status" = 'finished' THEN 'completed'
		WHEN "status" = 'failed' THEN 'failed'
		WHEN "status" = 'interrupted' THEN 'interrupted'
		ELSE NULL
	END,
	"completed_at" = CASE
		WHEN "status" IN ('finished', 'failed', 'interrupted') THEN "updated_at"
		ELSE NULL
	END;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "chat_answer_events"
		WHERE "type" NOT IN (
			'task_started',
			'meta_info',
			'thinking',
			'data',
			'current_tool_use',
			'tool_result',
			'citation',
			'artifact',
			'result',
			'error',
			'task_completed',
			'heartbeat'
		)
	) THEN
		RAISE EXCEPTION 'Cannot migrate unknown chat_answer_events type to AgentEvent V2';
	END IF;
END $$;--> statement-breakpoint
DROP INDEX "uq_chat_answer_events_answer_seq";--> statement-breakpoint
WITH "ranked_task_started" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "answer_id"
			ORDER BY "seq", "created_at", "id"
		) AS "rank"
	FROM "chat_answer_events"
	WHERE "type" = 'task_started'
)
UPDATE "chat_answer_events" AS "event"
SET
	"type" = 'meta_info',
	"content_json" = jsonb_build_object('route', 'legacy_duplicate_task_started')
FROM "ranked_task_started"
WHERE "event"."id" = "ranked_task_started"."id" AND "ranked_task_started"."rank" > 1;--> statement-breakpoint
UPDATE "chat_answer_events" AS "event"
SET
	"type" = 'data',
	"content_json" = jsonb_build_object('text', COALESCE("event"."content_json" ->> 'text', ''))
FROM "chat_answers" AS "answer"
WHERE
	"event"."answer_id" = "answer"."id"
	AND "event"."type" = 'result'
	AND "answer"."status" <> 'finished';--> statement-breakpoint
UPDATE "chat_answer_events" AS "event"
SET
	"type" = 'thinking',
	"content_json" = jsonb_build_object(
		'text',
		COALESCE("event"."content_json" ->> 'message', 'Legacy non-failure error')
	)
FROM "chat_answers" AS "answer"
WHERE
	"event"."answer_id" = "answer"."id"
	AND "event"."type" = 'error'
	AND "answer"."status" <> 'failed';--> statement-breakpoint
WITH "ranked_results" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "answer_id"
			ORDER BY "seq" DESC, "created_at" DESC, "id" DESC
		) AS "rank"
	FROM "chat_answer_events"
	WHERE "type" = 'result'
)
UPDATE "chat_answer_events" AS "event"
SET
	"type" = 'data',
	"content_json" = jsonb_build_object('text', COALESCE("event"."content_json" ->> 'text', ''))
FROM "ranked_results"
WHERE "event"."id" = "ranked_results"."id" AND "ranked_results"."rank" > 1;--> statement-breakpoint
WITH "ranked_completions" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "answer_id"
			ORDER BY "seq" DESC, "created_at" DESC, "id" DESC
		) AS "rank"
	FROM "chat_answer_events"
	WHERE "type" = 'task_completed'
)
UPDATE "chat_answer_events" AS "event"
SET
	"type" = 'meta_info',
	"content_json" = jsonb_build_object('route', 'legacy_duplicate_task_completed')
FROM "ranked_completions"
WHERE "event"."id" = "ranked_completions"."id" AND "ranked_completions"."rank" > 1;--> statement-breakpoint
INSERT INTO "chat_answer_events" (
	"id",
	"answer_id",
	"schema_version",
	"type",
	"content_json",
	"seq",
	"created_at",
	"updated_at"
)
SELECT
	'event_migrated_start_' || md5("answer"."id"),
	"answer"."id",
	2,
	'task_started',
	jsonb_build_object('message', "question"."message"),
	-1,
	"answer"."started_at",
	"answer"."started_at"
FROM "chat_answers" AS "answer"
INNER JOIN "chat_questions" AS "question" ON "question"."id" = "answer"."question_id"
WHERE NOT EXISTS (
	SELECT 1
	FROM "chat_answer_events" AS "event"
	WHERE "event"."answer_id" = "answer"."id" AND "event"."type" = 'task_started'
);--> statement-breakpoint
UPDATE "chat_answer_events" AS "event"
SET
	"schema_version" = 2,
	"content_json" = CASE
		WHEN "event"."type" = 'task_started' THEN
			jsonb_build_object('message', "question"."message")
		WHEN "event"."type" = 'meta_info' THEN
			jsonb_strip_nulls(jsonb_build_object('route', NULLIF("event"."content_json" ->> 'route', '')))
		WHEN "event"."type" = 'thinking' THEN
			jsonb_build_object(
				'chunk_id', 'thinking_' || "event"."id",
				'text', COALESCE("event"."content_json" ->> 'text', '')
			)
		WHEN "event"."type" = 'data' THEN
			jsonb_build_object(
				'chunk_id', 'message_' || "answer"."id",
				'text', COALESCE("event"."content_json" ->> 'text', '')
			)
		WHEN "event"."type" = 'current_tool_use' THEN
			jsonb_strip_nulls(jsonb_build_object(
				'tool_use_id', COALESCE(NULLIF("event"."content_json" ->> 'tool_use_id', ''), 'tool_' || "event"."id"),
				'name', COALESCE(NULLIF("event"."content_json" ->> 'name', ''), 'unknown'),
				'input', "event"."content_json" -> 'input'
			))
		WHEN "event"."type" = 'tool_result' THEN
			jsonb_strip_nulls(jsonb_build_object(
				'tool_use_id', COALESCE(NULLIF("event"."content_json" ->> 'tool_use_id', ''), 'tool_' || "event"."id"),
				'result', "event"."content_json" -> 'result',
				'is_error', CASE
					WHEN jsonb_typeof("event"."content_json" -> 'is_error') = 'boolean'
						THEN "event"."content_json" -> 'is_error'
					ELSE NULL
				END
			))
		WHEN "event"."type" = 'citation' THEN
			jsonb_build_object(
				'message_chunk_id', 'message_' || "answer"."id",
				'citations', COALESCE((
					SELECT jsonb_agg(
						jsonb_strip_nulls(jsonb_build_object(
							'id', CASE WHEN jsonb_typeof("citation"."value" -> 'id') = 'string' THEN "citation"."value" -> 'id' ELSE NULL END,
							'file_id', CASE WHEN jsonb_typeof("citation"."value" -> 'file_id') = 'string' THEN "citation"."value" -> 'file_id' ELSE NULL END,
							'title', CASE WHEN jsonb_typeof("citation"."value" -> 'title') = 'string' THEN "citation"."value" -> 'title' ELSE NULL END,
							'page', CASE WHEN jsonb_typeof("citation"."value" -> 'page') = 'number' THEN "citation"."value" -> 'page' ELSE NULL END,
							'snippet', CASE WHEN jsonb_typeof("citation"."value" -> 'snippet') = 'string' THEN "citation"."value" -> 'snippet' ELSE NULL END
						))
						ORDER BY "citation"."ordinality"
					)
					FROM jsonb_array_elements(
						CASE
							WHEN jsonb_typeof("event"."content_json" -> 'citations') = 'array'
								THEN "event"."content_json" -> 'citations'
							ELSE '[]'::jsonb
						END
					) WITH ORDINALITY AS "citation"("value", "ordinality")
					WHERE jsonb_typeof("citation"."value") = 'object'
				), '[]'::jsonb)
			)
		WHEN "event"."type" = 'artifact' THEN
			CASE
				WHEN jsonb_typeof("event"."content_json" -> 'artifact') = 'object' THEN
					jsonb_build_object(
						'artifact',
						jsonb_strip_nulls(jsonb_build_object(
							'id', CASE
								WHEN jsonb_typeof("event"."content_json" -> 'artifact' -> 'id') = 'string'
									THEN "event"."content_json" -> 'artifact' -> 'id'
								ELSE NULL
							END,
							'name', CASE
								WHEN jsonb_typeof("event"."content_json" -> 'artifact' -> 'name') = 'string'
									THEN "event"."content_json" -> 'artifact' -> 'name'
								ELSE NULL
							END
						))
					)
				WHEN jsonb_typeof("event"."content_json" -> 'artifacts') = 'array' THEN
					jsonb_build_object('artifacts', COALESCE((
						SELECT jsonb_agg(
							jsonb_strip_nulls(jsonb_build_object(
								'id', CASE WHEN jsonb_typeof("artifact"."value" -> 'id') = 'string' THEN "artifact"."value" -> 'id' ELSE NULL END,
								'name', CASE WHEN jsonb_typeof("artifact"."value" -> 'name') = 'string' THEN "artifact"."value" -> 'name' ELSE NULL END
							))
							ORDER BY "artifact"."ordinality"
						)
						FROM jsonb_array_elements("event"."content_json" -> 'artifacts')
							WITH ORDINALITY AS "artifact"("value", "ordinality")
						WHERE jsonb_typeof("artifact"."value") = 'object'
					), '[]'::jsonb))
				ELSE jsonb_build_object('artifacts', '[]'::jsonb)
			END
		WHEN "event"."type" = 'result' THEN
			jsonb_build_object(
				'final_message_chunk_id', 'message_' || "answer"."id",
				'text', COALESCE("event"."content_json" ->> 'text', '')
			) || CASE
				WHEN jsonb_typeof("event"."content_json" -> 'artifacts') = 'array' THEN
					jsonb_build_object('artifacts', COALESCE((
						SELECT jsonb_agg(
							jsonb_strip_nulls(jsonb_build_object(
								'id', CASE WHEN jsonb_typeof("artifact"."value" -> 'id') = 'string' THEN "artifact"."value" -> 'id' ELSE NULL END,
								'name', CASE WHEN jsonb_typeof("artifact"."value" -> 'name') = 'string' THEN "artifact"."value" -> 'name' ELSE NULL END
							))
							ORDER BY "artifact"."ordinality"
						)
						FROM jsonb_array_elements("event"."content_json" -> 'artifacts')
							WITH ORDINALITY AS "artifact"("value", "ordinality")
						WHERE jsonb_typeof("artifact"."value") = 'object'
					), '[]'::jsonb))
				ELSE '{}'::jsonb
			END
		WHEN "event"."type" = 'error' THEN
			jsonb_strip_nulls(jsonb_build_object(
				'message', COALESCE("event"."content_json" ->> 'message', 'Generation failed'),
				'error_code', CASE
					WHEN jsonb_typeof("event"."content_json" -> 'error_code') IN ('number', 'string')
						THEN "event"."content_json" -> 'error_code'
					ELSE NULL
				END
			))
		WHEN "event"."type" = 'task_completed' THEN
			jsonb_build_object(
				'message', CASE
					WHEN "answer"."status" = 'finished' THEN 'done'
					WHEN "answer"."status" = 'failed' THEN 'failed'
					WHEN "answer"."status" = 'interrupted' THEN 'interrupted'
					ELSE COALESCE("event"."content_json" ->> 'message', 'done')
				END
			)
		WHEN "event"."type" = 'heartbeat' THEN
			jsonb_build_object('at', floor(extract(epoch FROM "event"."created_at") * 1000)::bigint)
		ELSE "event"."content_json"
	END
FROM "chat_answers" AS "answer"
INNER JOIN "chat_questions" AS "question" ON "question"."id" = "answer"."question_id"
WHERE "event"."answer_id" = "answer"."id";--> statement-breakpoint
INSERT INTO "chat_answer_events" (
	"id",
	"answer_id",
	"schema_version",
	"type",
	"content_json",
	"seq",
	"created_at",
	"updated_at"
)
SELECT
	'event_migrated_result_' || md5("answer"."id"),
	"answer"."id",
	2,
	'result',
	jsonb_build_object(
		'final_message_chunk_id', 'message_' || "answer"."id",
		'text', COALESCE((
			SELECT string_agg(COALESCE("event"."content_json" ->> 'text', ''), '' ORDER BY "event"."seq", "event"."created_at", "event"."id")
			FROM "chat_answer_events" AS "event"
			WHERE "event"."answer_id" = "answer"."id" AND "event"."type" = 'data'
		), '')
	),
	COALESCE((
		SELECT MAX("event"."seq")
		FROM "chat_answer_events" AS "event"
		WHERE "event"."answer_id" = "answer"."id"
	), -1) + 1,
	"answer"."completed_at",
	"answer"."completed_at"
FROM "chat_answers" AS "answer"
WHERE "answer"."status" = 'finished'
	AND NOT EXISTS (
		SELECT 1
		FROM "chat_answer_events" AS "event"
		WHERE "event"."answer_id" = "answer"."id" AND "event"."type" = 'result'
	);--> statement-breakpoint
INSERT INTO "chat_answer_events" (
	"id",
	"answer_id",
	"schema_version",
	"type",
	"content_json",
	"seq",
	"created_at",
	"updated_at"
)
SELECT
	'event_migrated_error_' || md5("answer"."id"),
	"answer"."id",
	2,
	'error',
	jsonb_build_object(
		'error_code', 43106,
		'message', 'Generation failed before the legacy error event was persisted'
	),
	COALESCE((
		SELECT MAX("event"."seq")
		FROM "chat_answer_events" AS "event"
		WHERE "event"."answer_id" = "answer"."id"
	), -1) + 1,
	"answer"."completed_at",
	"answer"."completed_at"
FROM "chat_answers" AS "answer"
WHERE "answer"."status" = 'failed'
	AND NOT EXISTS (
		SELECT 1
		FROM "chat_answer_events" AS "event"
		WHERE "event"."answer_id" = "answer"."id" AND "event"."type" = 'error'
	);--> statement-breakpoint
INSERT INTO "chat_answer_events" (
	"id",
	"answer_id",
	"schema_version",
	"type",
	"content_json",
	"seq",
	"created_at",
	"updated_at"
)
SELECT
	'event_migrated_complete_' || md5("answer"."id"),
	"answer"."id",
	2,
	'task_completed',
	jsonb_build_object(
		'message', CASE
			WHEN "answer"."status" = 'finished' THEN 'done'
			WHEN "answer"."status" = 'failed' THEN 'failed'
			ELSE 'interrupted'
		END
	),
	COALESCE((
		SELECT MAX("event"."seq")
		FROM "chat_answer_events" AS "event"
		WHERE "event"."answer_id" = "answer"."id"
	), -1) + 1,
	"answer"."completed_at",
	"answer"."completed_at"
FROM "chat_answers" AS "answer"
WHERE "answer"."status" IN ('finished', 'failed', 'interrupted')
	AND NOT EXISTS (
		SELECT 1
		FROM "chat_answer_events" AS "event"
		WHERE "event"."answer_id" = "answer"."id" AND "event"."type" = 'task_completed'
	);--> statement-breakpoint
WITH "ordered_events" AS (
	SELECT
		"id",
		(row_number() OVER (
			PARTITION BY "answer_id"
			ORDER BY
				CASE
					WHEN "type" = 'task_started' THEN 0
					WHEN "type" = 'task_completed' THEN 2
					ELSE 1
				END,
				"seq",
				"created_at",
				"id"
		) - 1)::integer AS "normalized_seq"
	FROM "chat_answer_events"
)
UPDATE "chat_answer_events" AS "event"
SET "seq" = "ordered_events"."normalized_seq"
FROM "ordered_events"
WHERE "event"."id" = "ordered_events"."id";--> statement-breakpoint
UPDATE "chat_answers" AS "answer"
SET "last_event_seq" = COALESCE((
	SELECT MAX("event"."seq")
	FROM "chat_answer_events" AS "event"
	WHERE "event"."answer_id" = "answer"."id"
), -1);--> statement-breakpoint
ALTER TABLE "chat_answer_events" ALTER COLUMN "schema_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "chat_answer_events" ALTER COLUMN "schema_version" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_answer_events_answer_seq" ON "chat_answer_events" USING btree ("answer_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_answer_events_terminal_type" ON "chat_answer_events" USING btree ("answer_id","type") WHERE "chat_answer_events"."schema_version" = 2 and "chat_answer_events"."type" in ('result', 'task_completed');

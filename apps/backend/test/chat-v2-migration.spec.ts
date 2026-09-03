import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), 'drizzle/0002_overconfident_betty_ross.sql'), 'utf8');
const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'drizzle/meta/0002_snapshot.json'), 'utf8')) as {
  tables: Record<string, { columns: Record<string, { notNull: boolean; default?: number }> }>;
};

describe('AgentEvent V2 migration contract', () => {
  it('backfills durable identities without deleting legacy history', () => {
    expect(migration).toContain(`SET "request_id" = 'request_migrated_v2_' || md5("id")`);
    expect(migration).toContain('ALTER TABLE "chat_questions" ALTER COLUMN "request_id" SET NOT NULL');
    expect(migration).toContain(`UPDATE "chat_answers" SET "run_id" = 'run_' || md5("id")`);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"chat_answer_events"/i);
    expect(snapshot.tables['public.chat_questions'].columns.request_id.notNull).toBe(true);
  });

  it('creates one ordered V2 journal with typed chunk references', () => {
    const dropSequenceIndex = migration.indexOf('DROP INDEX "uq_chat_answer_events_answer_seq"');
    const insertTaskStarted = migration.indexOf(`'task_started',\n\tjsonb_build_object('message'`);
    const normalizeSequence = migration.indexOf('WITH "ordered_events"');
    const recreateSequenceIndex = migration.indexOf('CREATE UNIQUE INDEX "uq_chat_answer_events_answer_seq"');

    expect(dropSequenceIndex).toBeGreaterThan(-1);
    expect(insertTaskStarted).toBeGreaterThan(dropSequenceIndex);
    expect(normalizeSequence).toBeGreaterThan(insertTaskStarted);
    expect(recreateSequenceIndex).toBeGreaterThan(normalizeSequence);
    expect(migration).toContain(`'chunk_id', 'thinking_' || "event"."id"`);
    expect(migration).toContain(`'chunk_id', 'message_' || "answer"."id"`);
    expect(migration).toContain(`'message_chunk_id', 'message_' || "answer"."id"`);
    expect(migration).toContain(`'final_message_chunk_id', 'message_' || "answer"."id"`);
    expect(migration).toContain(`WHERE jsonb_typeof("artifact"."value") = 'object'`);
    expect(migration).not.toContain(`jsonb_build_object('artifacts', "event"."content_json" -> 'artifacts')`);
    expect(migration).toContain('SET\n\t"schema_version" = 2');
    expect(migration).not.toContain('"schema_version" = 1');
  });

  it('repairs terminal rows before adding V2 idempotence constraints', () => {
    const demoteNonFinishedResult = migration.indexOf(
      `"event"."type" = 'result'\n\tAND "answer"."status" <> 'finished'`,
    );
    const demoteNonFailedError = migration.indexOf(`"event"."type" = 'error'\n\tAND "answer"."status" <> 'failed'`);
    const insertResult = migration.indexOf(`'event_migrated_result_'`);
    const insertError = migration.indexOf(`'event_migrated_error_'`);
    const insertCompletion = migration.indexOf(`'event_migrated_complete_'`);
    const recomputeLastSequence = migration.indexOf('UPDATE "chat_answers" AS "answer"');
    const terminalIndex = migration.lastIndexOf('CREATE UNIQUE INDEX "uq_chat_answer_events_terminal_type"');

    expect(migration).toContain(`WHERE "answer"."status" IN ('finished', 'failed', 'interrupted')`);
    expect(migration).toContain(`"event"."type" = 'task_completed'`);
    expect(demoteNonFinishedResult).toBeGreaterThan(-1);
    expect(demoteNonFailedError).toBeGreaterThan(demoteNonFinishedResult);
    expect(insertResult).toBeGreaterThan(-1);
    expect(insertError).toBeGreaterThan(insertResult);
    expect(insertCompletion).toBeGreaterThan(insertError);
    expect(recomputeLastSequence).toBeGreaterThan(insertCompletion);
    expect(terminalIndex).toBeGreaterThan(recomputeLastSequence);
    expect(snapshot.tables['public.chat_answer_events'].columns.schema_version).toMatchObject({
      notNull: true,
      default: 2,
    });
  });
});

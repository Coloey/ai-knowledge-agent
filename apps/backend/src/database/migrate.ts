import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';

import { validateEnvironment } from '../config/environment';

interface MigrationJournal {
  entries: Array<{ when: number; tag: string }>;
}

async function baselineExistingAlembicDatabase(client: PoolClient, migrationsFolder: string): Promise<void> {
  const [{ usersTable, drizzleTable }] = (
    await client.query<{ usersTable: string | null; drizzleTable: string | null }>(
      `select to_regclass('public.users')::text as "usersTable",
              to_regclass('drizzle.__drizzle_migrations')::text as "drizzleTable"`,
    )
  ).rows;
  if (!usersTable || drizzleTable) return;

  const journal = JSON.parse(
    await readFile(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as MigrationJournal;
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error('Drizzle migration journal is empty');

  await client.query('begin');
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      ALTER TABLE chat_questions ADD COLUMN IF NOT EXISTS request_id varchar(128);

      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        id varchar(64) PRIMARY KEY,
        user_id varchar(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        family_id varchar(64) NOT NULL,
        token_hash varchar(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        replaced_by_id varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_refresh_tokens_token_hash ON auth_refresh_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS ix_auth_refresh_tokens_user_id ON auth_refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS ix_auth_refresh_tokens_family_id ON auth_refresh_tokens(family_id);

      CREATE TABLE IF NOT EXISTS outbox_events (
        id varchar(64) PRIMARY KEY,
        aggregate_type varchar(64) NOT NULL,
        aggregate_id varchar(64) NOT NULL,
        event_type varchar(120) NOT NULL,
        payload_json jsonb NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz,
        last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ix_outbox_events_pending ON outbox_events(published_at, available_at);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_questions_request_id ON chat_questions(request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_answers_question_id ON chat_answers(question_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_answer_events_answer_seq ON chat_answer_events(answer_id, seq);
      CREATE INDEX IF NOT EXISTS ix_workspace_members_user_id ON workspace_members(user_id);

      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      `baseline:${latest.tag}`,
      latest.when,
    ]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function main(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const migrationsFolder = resolve(process.cwd(), 'drizzle');
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1, application_name: 'ai-agent-migration' });
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(61420260730)');
    await baselineExistingAlembicDatabase(client, migrationsFolder);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock(61420260730)').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

void main();

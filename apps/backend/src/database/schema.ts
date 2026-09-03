import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    avatar: varchar('avatar', { length: 500 }).default('').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('uq_users_email').on(table.email)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    ownerId: varchar('owner_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (table) => [index('ix_workspaces_owner_id').on(table.ownerId)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: varchar('workspace_id', { length: 64 })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 32 }).default('member').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('ix_workspace_members_user_id').on(table.userId),
  ],
);

export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    userId: varchar('user_id', { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: varchar('family_id', { length: 64 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: varchar('replaced_by_id', { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_auth_refresh_tokens_token_hash').on(table.tokenHash),
    index('ix_auth_refresh_tokens_user_id').on(table.userId),
    index('ix_auth_refresh_tokens_family_id').on(table.familyId),
  ],
);

export const libraryFiles = pgTable(
  'library_files',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 64 })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    uploaderId: varchar('uploader_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 255 }).notNull(),
    fileType: varchar('file_type', { length: 64 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: varchar('storage_key', { length: 1000 }).notNull(),
    parseStatus: varchar('parse_status', { length: 32 }).default('pending').notNull(),
    errorMessage: text('error_message').default('').notNull(),
    ...timestamps,
  },
  (table) => [
    index('ix_library_files_workspace_id').on(table.workspaceId),
    index('ix_library_files_uploader_id').on(table.uploaderId),
    index('ix_library_files_parse_status').on(table.parseStatus),
  ],
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    fileId: varchar('file_id', { length: 64 })
      .notNull()
      .references(() => libraryFiles.id, { onDelete: 'cascade' }),
    workspaceId: varchar('workspace_id', { length: 64 })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    page: integer('page'),
    startOffset: integer('start_offset').default(0).notNull(),
    endOffset: integer('end_offset').default(0).notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    ...timestamps,
  },
  (table) => [
    index('ix_document_chunks_file_id').on(table.fileId),
    index('ix_document_chunks_workspace_id').on(table.workspaceId),
    index('ix_document_chunks_embedding_hnsw').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
);

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 64 })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    creatorId: varchar('creator_id', { length: 64 })
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).default('active').notNull(),
    ...timestamps,
  },
  (table) => [
    index('ix_chat_sessions_workspace_id').on(table.workspaceId),
    index('ix_chat_sessions_creator_id').on(table.creatorId),
  ],
);

export const chatQuestions = pgTable(
  'chat_questions',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    sessionId: varchar('session_id', { length: 64 })
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    message: text('message').notNull(),
    optionsJson: jsonb('options_json').$type<Record<string, unknown>>().default({}).notNull(),
    timezoneOffset: integer('timezone_offset').default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    index('ix_chat_questions_session_id').on(table.sessionId),
    uniqueIndex('uq_chat_questions_request_id').on(table.requestId),
  ],
);

export const chatAnswers = pgTable(
  'chat_answers',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    sessionId: varchar('session_id', { length: 64 })
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    questionId: varchar('question_id', { length: 64 })
      .notNull()
      .references(() => chatQuestions.id, { onDelete: 'cascade' }),
    runId: varchar('run_id', { length: 64 }).notNull(),
    lastEventSeq: integer('last_event_seq').default(-1).notNull(),
    terminalReason: varchar('terminal_reason', { length: 64 }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: varchar('status', { length: 32 }).default('streaming').notNull(),
    rating: integer('rating'),
    ...timestamps,
  },
  (table) => [
    index('ix_chat_answers_session_id').on(table.sessionId),
    uniqueIndex('uq_chat_answers_question_id').on(table.questionId),
  ],
);

export const chatAnswerEvents = pgTable(
  'chat_answer_events',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    answerId: varchar('answer_id', { length: 64 })
      .notNull()
      .references(() => chatAnswers.id, { onDelete: 'cascade' }),
    schemaVersion: integer('schema_version').default(2).notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    contentJson: jsonb('content_json').$type<Record<string, unknown>>().default({}).notNull(),
    seq: integer('seq').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_chat_answer_events_answer_seq').on(table.answerId, table.seq),
    uniqueIndex('uq_chat_answer_events_terminal_type')
      .on(table.answerId, table.type)
      .where(sql`${table.schemaVersion} = 2 and ${table.type} in ('result', 'task_completed')`),
    index('ix_chat_answer_events_type').on(table.type),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 64 })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().default({}).notNull(),
    errorMessage: text('error_message').default('').notNull(),
    ...timestamps,
  },
  (table) => [
    index('ix_jobs_workspace_id').on(table.workspaceId),
    index('ix_jobs_status').on(table.status),
    index('ix_jobs_type').on(table.type),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error').default('').notNull(),
    ...timestamps,
  },
  (table) => [index('ix_outbox_events_pending').on(table.publishedAt, table.availableAt)],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    userId: varchar('user_id', { length: 64 }).references(() => users.id, { onDelete: 'set null' }),
    workspaceId: varchar('workspace_id', { length: 64 }).references(() => workspaces.id, { onDelete: 'set null' }),
    eventName: varchar('event_name', { length: 120 }).notNull(),
    propertiesJson: jsonb('properties_json').$type<Record<string, unknown>>().default({}).notNull(),
    ...timestamps,
  },
  (table) => [
    index('ix_analytics_events_event_name').on(table.eventName),
    index('ix_analytics_events_user_id').on(table.userId),
    index('ix_analytics_events_workspace_id').on(table.workspaceId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({ memberships: many(workspaceMembers) }));
export const workspaceRelations = relations(workspaces, ({ many, one }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  members: many(workspaceMembers),
}));

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('artifact schema migration', () => {
  it('creates versioned artifact and job uniqueness with bounded job progress', async () => {
    const migration = await readFile(join(process.cwd(), 'drizzle/0003_naive_the_twelve.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE "artifacts"');
    expect(migration).toContain('CREATE TABLE "artifact_jobs"');
    expect(migration).toContain('uq_artifacts_answer_kind_version');
    expect(migration).toContain('uq_artifact_jobs_artifact_version');
    expect(migration).toContain('ck_artifact_jobs_progress_range');
    expect(migration).toContain('between 0 and 100');
  });
});

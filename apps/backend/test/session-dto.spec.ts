import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SendMessageRequestDto } from '../src/sessions/session.dto';

describe('SendMessageRequestDto', () => {
  it('accepts document as the only output artifact request while retaining other options', async () => {
    const errors = await validate(
      plainToInstance(SendMessageRequestDto, {
        workspace_id: 'workspace_1',
        message: 'question',
        options: { output_artifact: 'document', existing_option: true },
      }),
    );

    expect(errors).toEqual([]);
  });

  it('accepts options without an artifact request', async () => {
    const errors = await validate(
      plainToInstance(SendMessageRequestDto, {
        workspace_id: 'workspace_1',
        message: 'question',
        options: { existing_option: true },
      }),
    );

    expect(errors).toEqual([]);
  });

  it('rejects null options', async () => {
    const errors = await validate(
      plainToInstance(SendMessageRequestDto, {
        workspace_id: 'workspace_1',
        message: 'question',
        options: null,
      }),
    );

    expect(errors).not.toEqual([]);
  });

  it.each(['presentation', '', 1, null])('rejects unsupported output_artifact values: %j', async (value) => {
    const errors = await validate(
      plainToInstance(SendMessageRequestDto, {
        workspace_id: 'workspace_1',
        message: 'question',
        options: { output_artifact: value },
      }),
    );

    expect(errors).not.toEqual([]);
  });
});

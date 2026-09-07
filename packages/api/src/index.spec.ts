import { readFileSync } from 'node:fs';

import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiClient,
  AuthExpiredError,
  artifactDetailQueryKey,
  artifactDetailQueryOptions,
  artifactRefetchInterval,
  artifactRetryMutationOptions,
} from './index';

describe('ApiClient.getBlob', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads an authenticated binary response without JSON decoding', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 255]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new ApiClient({
      baseURL: 'https://api.example.test',
      token: 'secret-token',
    });

    const blob = await client.getBlob(
      '/artifacts/artifact_1/content?disposition=attachment',
    );

    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([
      0, 1, 2, 255,
    ]);
    expect(blob.type).toBe('application/octet-stream');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/artifacts/artifact_1/content?disposition=attachment',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer secret-token' },
      }),
    );
  });

  it('preserves authenticated API error handling for a 401 JSON envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: 401, data: null, msg: 'Token expired' },
            { status: 401, statusText: 'Unauthorized' },
          ),
        ),
    );
    const client = new ApiClient({
      baseURL: 'https://api.example.test',
      token: 'expired-token',
    });

    await expect(
      client.getBlob('/artifacts/artifact_1/content'),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'AuthExpiredError',
        message: 'Token expired',
      }),
    );
    await expect(
      client.getBlob('/artifacts/artifact_1/content'),
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('forwards abort signals and preserves the fetch AbortError', async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new ApiClient({ baseURL: 'https://api.example.test' });
    const controller = new AbortController();

    const download = client.getBlob(
      '/artifacts/artifact_1/content',
      controller.signal,
    );
    controller.abort();

    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/artifacts/artifact_1/content',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('uses a non-401 JSON error envelope message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 40901,
            data: null,
            msg: 'Artifact content is not available',
          },
          { status: 409, statusText: 'Conflict' },
        ),
      ),
    );
    const client = new ApiClient({ baseURL: 'https://api.example.test' });

    await expect(
      client.getBlob('/artifacts/artifact_1/content'),
    ).rejects.toThrow('Artifact content is not available');
  });
});

describe('Artifact query configuration', () => {
  it('uses an exact ID-scoped key and forwards query cancellation', async () => {
    const client = { get: vi.fn().mockResolvedValue(detail('processing')) };
    const options = artifactDetailQueryOptions(client as never, 'artifact/1');
    const controller = new AbortController();

    expect(options.queryKey).toEqual(['artifact', 'artifact/1']);
    await expect(
      options.queryFn?.({ signal: controller.signal } as never),
    ).resolves.toEqual(detail('processing'));
    expect(client.get).toHaveBeenCalledWith(
      '/artifacts/artifact%2F1',
      controller.signal,
    );
  });

  it.each([
    ['queued', 1_500],
    ['processing', 1_500],
    ['completed', false],
    ['failed', false],
    [undefined, false],
  ] as const)(
    'returns the expected polling interval for %s',
    (status, expected) => {
      expect(artifactRefetchInterval(status ? detail(status) : undefined)).toBe(
        expected,
      );
    },
  );

  it('invalidates only the retried Artifact query', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      artifactDetailQueryKey('artifact_1'),
      detail('failed'),
    );
    queryClient.setQueryData(
      artifactDetailQueryKey('artifact_2'),
      detail('completed'),
    );
    const client = {
      post: vi.fn().mockResolvedValue({ ...detail('queued'), version: 2 }),
    };
    const mutation = queryClient
      .getMutationCache()
      .build(
        queryClient,
        artifactRetryMutationOptions(
          client as never,
          queryClient,
          'artifact_1',
        ),
      );

    await mutation.execute(undefined);

    expect(client.post).toHaveBeenCalledWith('/artifacts/artifact_1/retry', {});
    expect(
      queryClient.getQueryState(artifactDetailQueryKey('artifact_1'))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(artifactDetailQueryKey('artifact_2'))
        ?.isInvalidated,
    ).toBe(false);
  });
});

describe('ArtifactQueryProvider lifecycle', () => {
  it('creates its QueryClient lazily once per keyed authenticated subtree and clears it on unmount', () => {
    const source = readFileSync(
      new URL('./index.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/useState\(createArtifactQueryClient\)/);
    expect(source).toMatch(/return \(\) => queryClient\.clear\(\)/);
    expect(source).toMatch(
      /ArtifactQueryClientBoundary key=\{props\.identityKey\}/,
    );
  });
});

function detail(status: 'queued' | 'processing' | 'completed' | 'failed') {
  return {
    id: 'artifact_1',
    kind: 'document' as const,
    title: 'Report',
    status,
    workspace_id: 'workspace_1',
    session_id: 'session_1',
    answer_id: 'answer_1',
    progress: status === 'completed' ? 100 : 10,
    version: 1,
    created_at: 1,
    updated_at: 2,
  };
}

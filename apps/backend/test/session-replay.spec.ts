import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { SessionsService } from '../src/sessions/sessions.service';

describe('SessionsService replay', () => {
  it('finishes an empty replay without starting a second generation', async () => {
    const llm = { streamAnswer: vi.fn() };
    const write = vi.fn();
    const response = {
      destroyed: false,
      writableEnded: false,
      write,
      end: vi.fn(),
    } as unknown as ServerResponse;
    const service = new SessionsService({} as never, {} as never, {} as never, llm as never, {} as never, {} as never);

    await service.stream(
      {
        sessionId: 'session_1',
        answerId: 'answer_1',
        question: 'hello',
        replay: [],
      },
      response,
      new AbortController(),
    );

    expect(llm.streamAnswer).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('event: done\ndata: {"done":true}\n\n');
    expect(response.end).toHaveBeenCalledOnce();
  });
});

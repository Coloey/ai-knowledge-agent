import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');

describe('SmartBar presentation boundary', () => {
  it('does not own SSE parsing, AgentEvent decoding, or AbortControllers', () => {
    expect(source).not.toMatch(
      /TextDecoder|ReadableStream|createSseDecoder|decodeAgentEvent|AbortController/,
    );
    expect(source).not.toMatch(/event\.type|switch\s*\(/);
  });

  it.each([
    ['thinking chunks', 'chunk-thinking'],
    ['message chunks', 'chunk-message'],
    ['generic tool calls', "knownLabel || 'Tool call'"],
    ['citations', '<CitationList'],
    ['system errors', '<SystemNoticeView'],
  ])('keeps a renderer for %s', (_label, marker) => {
    expect(source).toContain(marker);
  });
});

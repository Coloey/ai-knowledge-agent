import { describe, expect, it } from 'vitest';

import { splitText } from '../src/library/text-splitter';

describe('splitText', () => {
  it('normalizes whitespace and preserves overlap offsets', () => {
    const chunks = splitText([{ page: 2, text: '  abc   def ghi  ' }], 7, 2);
    expect(chunks).toEqual([
      { content: 'abc def', page: 2, startOffset: 0, endOffset: 7 },
      { content: 'ef ghi', page: 2, startOffset: 5, endOffset: 11 },
    ]);
  });

  it('rejects invalid overlap settings', () => {
    expect(() => splitText([], 100, 100)).toThrow('Invalid chunk configuration');
  });
});

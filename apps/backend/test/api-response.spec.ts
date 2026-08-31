import { describe, expect, it } from 'vitest';

import { fail, ok } from '../src/common/api-response';

describe('API response contract', () => {
  it('keeps the existing success envelope', () => {
    expect(ok({ id: 'user_1' })).toEqual({ code: 0, data: { id: 'user_1' }, msg: 'ok' });
  });

  it('keeps the existing failure envelope', () => {
    expect(fail('Not found', 404)).toEqual({ code: 404, data: null, msg: 'Not found' });
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/auth/auth.service';

describe('AuthService refresh rotation', () => {
  it('revokes the active token family when a rotated token is replayed', async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: 'rt_old',
                    userId: 'user_1',
                    familyId: 'family_1',
                    tokenHash: 'hash',
                    expiresAt: new Date(Date.now() + 60_000),
                    revokedAt: new Date(),
                  },
                ]),
              }),
            }),
          }),
        }),
        update: () => ({ set: () => ({ where: updateWhere }) }),
      }),
    );
    const service = new AuthService({ db: { transaction } } as never, {} as never, {} as never, {} as never);

    await expect(service.refresh('already-rotated-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateWhere).toHaveBeenCalledOnce();
  });
});

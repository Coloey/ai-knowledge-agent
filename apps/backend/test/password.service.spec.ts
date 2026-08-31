import { describe, expect, it } from 'vitest';

import { PasswordService } from '../src/auth/password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('verifies legacy passlib pbkdf2_sha256 hashes', async () => {
    const hash = '$pbkdf2-sha256$29000$Zml4ZWRzYWx0MTIzNDU2$F31Pc.yRic7L69wMK.ESiCqd7YLj.kRq5dgQB1Lfi3Y';
    await expect(service.verify(hash, 'secret123')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
    expect(service.needsRehash(hash)).toBe(true);
  });

  it('hashes new passwords with argon2id', async () => {
    const hash = await service.hash('secret123');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(service.verify(hash, 'secret123')).resolves.toBe(true);
    expect(service.needsRehash(hash)).toBe(false);
  });
});

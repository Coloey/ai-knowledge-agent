import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash, verify } from 'argon2';

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hash(password, { type: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    if (passwordHash.startsWith('$argon2')) return verify(passwordHash, password);
    if (passwordHash.startsWith('$pbkdf2-sha256$')) return this.verifyPasslibPbkdf2(passwordHash, password);
    return false;
  }

  needsRehash(passwordHash: string): boolean {
    return !passwordHash.startsWith('$argon2');
  }

  private verifyPasslibPbkdf2(passwordHash: string, password: string): boolean {
    const [, algorithm, roundsValue, saltValue, checksumValue] = passwordHash.split('$');
    const rounds = Number(roundsValue);
    if (algorithm !== 'pbkdf2-sha256' || !Number.isSafeInteger(rounds) || rounds <= 0 || !saltValue || !checksumValue) {
      return false;
    }

    const salt = this.decodePasslibBase64(saltValue);
    const expected = this.decodePasslibBase64(checksumValue);
    const actual = pbkdf2Sync(password, salt, rounds, expected.length, 'sha256');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private decodePasslibBase64(value: string): Buffer {
    const normalized = value.replaceAll('.', '+');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(`${normalized}${padding}`, 'base64');
  }
}

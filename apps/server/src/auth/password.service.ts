import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export function validatePasswordInput(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.trim().length === 0) {
    throw new Error('password must not be blank');
  }
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new Error(
      `password must contain ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`,
    );
  }
}

@Injectable()
export class PasswordService {
  private dummyHashPromise: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    validatePasswordInput(password);
    return argon2.hash(password, ARGON2ID_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    if (typeof passwordHash !== 'string' || typeof password !== 'string') return false;
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async dummyHash(): Promise<string> {
    this.dummyHashPromise ??= argon2.hash('buildplatform-invalid-login-dummy', ARGON2ID_OPTIONS);
    return this.dummyHashPromise;
  }

  needsRehash(passwordHash: string): boolean {
    try {
      return argon2.needsRehash(passwordHash, ARGON2ID_OPTIONS);
    } catch {
      return true;
    }
  }
}

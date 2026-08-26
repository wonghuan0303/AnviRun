import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface TaskLease {
  readonly token: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

/** 任务租约的生成、哈希和常量时间校验。明文只在内存和 assignment 中短暂存在。 */
@Injectable()
export class TaskLeaseService {
  generate(timeoutSeconds: number, now = new Date()): TaskLease {
    const executionSeconds = Math.max(300, timeoutSeconds) + 60;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + executionSeconds * 1_000);
    return { token, hash: this.hash(token), expiresAt };
  }

  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  verify(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(token), 'utf8');
    const expected = Buffer.from(expectedHash, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

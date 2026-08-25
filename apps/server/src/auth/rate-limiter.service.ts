import { Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import { AuthConfigService } from '../config/auth.config';

interface Bucket {
  startedAt: number;
  count: number;
}

/** 单实例进程内登录限流器；多实例部署时必须替换为共享存储实现。 */
@Injectable()
export class LoginRateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly authConfig: AuthConfigService) {}

  assertAllowed(ip: string, username: string): void {
    if (
      this.isLimited(this.bucketKey('ip', ip)) ||
      this.isLimited(this.bucketKey('username', username))
    ) {
      throw new ApiException('AUTH_INVALID_CREDENTIALS', {
        message: '登录请求过于频繁，请稍后重试',
        status: 429,
      });
    }
  }

  recordFailure(ip: string, username: string): void {
    this.increment(this.bucketKey('ip', ip));
    this.increment(this.bucketKey('username', username));
  }

  recordSuccess(ip: string, username: string): void {
    this.buckets.delete(this.bucketKey('ip', ip));
    this.buckets.delete(this.bucketKey('username', username));
  }

  reset(): void {
    this.buckets.clear();
  }

  private bucketKey(kind: string, value: string): string {
    return `${kind}:${value.slice(0, 256)}`;
  }

  private isLimited(key: string): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return false;
    if (Date.now() - bucket.startedAt >= this.authConfig.values.loginRateLimitWindowMs) {
      this.buckets.delete(key);
      return false;
    }
    return bucket.count >= this.authConfig.values.loginRateLimitMax;
  }

  private increment(key: string): void {
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.authConfig.values.loginRateLimitWindowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
  }
}

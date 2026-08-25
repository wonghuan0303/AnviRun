import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AccessTokenGuard } from './access-token.guard';
import { AdminGuard } from './admin.guard';
import { AuthService } from './auth.service';
import { AuthConfigService } from '../config/auth.config';
import { CookieService } from './cookie.service';
import { CsrfService } from './csrf.service';
import { LoginRateLimiterService } from './rate-limiter.service';
import { PasswordService } from './password.service';
import { RefreshSessionService } from './refresh-session.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthConfigService,
    AuthService,
    PasswordService,
    TokenService,
    CookieService,
    CsrfService,
    RefreshSessionService,
    LoginRateLimiterService,
    AccessTokenGuard,
    AdminGuard,
  ],
  exports: [
    AuthConfigService,
    AuthService,
    PasswordService,
    TokenService,
    CookieService,
    CsrfService,
    RefreshSessionService,
    AccessTokenGuard,
    AdminGuard,
  ],
})
export class AuthModule {}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiException } from '../common/api-exception';
import { AccessTokenGuard } from './access-token.guard';
import type { AuthenticatedRequest } from './auth.types';
import { AuthService } from './auth.service';
import { CsrfService } from './csrf.service';
import { CurrentUser } from './current-user.decorator';
import { parseLoginDto, type LoginDto } from './dto/auth.dto';
import { CookieService } from './cookie.service';

function requestIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function requestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function userAgent(request: Request): string | undefined {
  return request.header('user-agent')?.slice(0, 200);
}

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
    private readonly csrf: CsrfService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noStore(response);
    let input: LoginDto;
    try {
      input = parseLoginDto(body);
    } catch {
      await this.auth.recordLoginFailure(requestId(request));
      throw new ApiException('VALIDATION_FAILED');
    }

    const result = await this.auth.login({
      ...input,
      ip: requestIp(request),
      userAgent: userAgent(request),
      requestId: requestId(request),
    });
    this.cookies.setAuthCookies(response, result.refreshToken, result.csrfToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    noStore(response);
    this.csrf.assertValid(request);
    const result = await this.auth.refresh({
      refreshToken: this.cookies.getRefreshToken(request),
      ip: requestIp(request),
      userAgent: userAgent(request),
      requestId: requestId(request),
    });
    this.cookies.setAuthCookies(response, result.refreshToken, result.csrfToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    noStore(response);
    const refreshToken = this.cookies.getRefreshToken(request);
    this.csrf.assertValid(request, !refreshToken);
    await this.auth.logout({ refreshToken, requestId: requestId(request) });
    this.cookies.clearAuthCookies(response);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  getMe(
    @CurrentUser() user: AuthenticatedRequest['user'],
    @Res({ passthrough: true }) response: Response,
  ) {
    noStore(response);
    if (!user) throw new ApiException('AUTH_TOKEN_EXPIRED');
    return { id: user.id, username: user.username, role: user.role, status: user.status };
  }
}

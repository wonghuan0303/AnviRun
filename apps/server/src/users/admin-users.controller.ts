import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';

import { AccessTokenGuard } from '../auth/access-token.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequestUser } from '../auth/auth.types';
import { parseCreateUserDto, parseResetPasswordDto } from '../auth/dto/auth.dto';
import { ApiException } from '../common/api-exception';
import { parseAdminUserListQuery } from './user.dto';
import { UsersService } from './users.service';

function getRequestId(request: Request): string | undefined {
  const value = request.header('x-request-id');
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

@Controller('api/admin/users')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    try {
      return await this.users.listUsers(parseAdminUserListQuery(query));
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('VALIDATION_FAILED');
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    let input;
    try {
      input = parseCreateUserDto(body);
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('VALIDATION_FAILED');
    }
    return this.users.createUser(
      actor.id,
      {
        username: input.username,
        password: input.password,
        role: (input.role ?? 'USER') as UserRole,
      },
      getRequestId(request),
    );
  }

  @Patch(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(
    @Param('id') userId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.users.disableUser(actor.id, userId, getRequestId(request));
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  enable(
    @Param('id') userId: string,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    return this.users.enableUser(actor.id, userId, getRequestId(request));
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Param('id') userId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedRequestUser,
    @Req() request: Request,
  ) {
    let input;
    try {
      input = parseResetPasswordDto(body);
    } catch {
      throw new ApiException('VALIDATION_FAILED');
    }
    return this.users.resetPassword(actor.id, userId, input.password, getRequestId(request));
  }
}

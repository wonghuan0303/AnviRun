import { Injectable } from '@nestjs/common';
import { Prisma, UserRole, UserStatus } from '@prisma/client';

import { ApiException } from '../common/api-exception';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { lockUserForUpdate } from '../database/user-lock';
import { normalizeUsername } from '../database/username';
import { type PublicUser } from '../auth/auth.types';
import { PasswordService, validatePasswordInput } from '../auth/password.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export interface AdminUserView {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

function assertUserId(userId: string): void {
  if (!UUID_PATTERN.test(userId)) throw new ApiException('RESOURCE_NOT_FOUND');
}

function adminUser(user: {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}): AdminUserView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicUser(user: {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
}): PublicUser {
  return { id: user.id, username: user.username, role: user.role, status: user.status };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async createUser(
    actorId: string,
    input: { username: string; password: string; role?: UserRole },
    requestId?: string,
  ): Promise<PublicUser> {
    let username: string;
    try {
      username = normalizeUsername(input.username);
      validatePasswordInput(input.password);
    } catch {
      throw new ApiException('VALIDATION_FAILED');
    }
    const role = input.role ?? UserRole.USER;
    const passwordHash = await this.passwords.hash(input.password);
    let user;
    try {
      user = await this.prisma.user.create({ data: { username, passwordHash, role } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApiException('VALIDATION_FAILED', { message: '用户名已存在' });
      }
      throw error;
    }
    await this.audit.record({
      actorId,
      action: 'USER_CREATED',
      resourceType: 'User',
      resourceId: user.id,
      requestId,
      metadata: { role },
    });
    return publicUser(user);
  }

  async listUsers(query: {
    page: number;
    pageSize: number;
    search?: string;
    role?: UserRole;
    status?: UserStatus;
  }): Promise<{
    items: AdminUserView[];
    page: number;
    pageSize: number;
    total: number;
    metrics: { total: number; active: number; disabled: number; admins: number };
  }> {
    const where: Prisma.UserWhereInput = {
      ...(query.search === undefined
        ? {}
        : { username: { contains: query.search, mode: 'insensitive' } }),
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const [total, allUsers, active, disabled, admins, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
      this.prisma.user.count({ where: { status: UserStatus.DISABLED } }),
      this.prisma.user.count({ where: { role: UserRole.ADMIN } }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: ADMIN_USER_SELECT,
      }),
    ]);

    return {
      items: users.map(adminUser),
      page: query.page,
      pageSize: query.pageSize,
      total,
      metrics: { total: allUsers, active, disabled, admins },
    };
  }

  async enableUser(actorId: string, userId: string, requestId?: string): Promise<PublicUser> {
    assertUserId(userId);
    return this.prisma.$transaction(async (transaction) => {
      if (!(await lockUserForUpdate(transaction, userId))) {
        throw new ApiException('RESOURCE_NOT_FOUND');
      }
      const target = await transaction.user.findUnique({ where: { id: userId } });
      if (!target) throw new ApiException('RESOURCE_NOT_FOUND');

      const updated =
        target.status === UserStatus.DISABLED
          ? await transaction.user.update({
              where: { id: userId },
              data: { status: UserStatus.ACTIVE },
            })
          : target;
      await this.audit.record(
        {
          actorId,
          action: 'USER_ENABLED',
          resourceType: 'User',
          resourceId: userId,
          requestId,
          metadata: { outcome: target.status === UserStatus.DISABLED ? 'enabled' : 'noop' },
        },
        transaction,
      );
      return publicUser(updated);
    });
  }

  async disableUser(actorId: string, userId: string, requestId?: string): Promise<PublicUser> {
    assertUserId(userId);
    if (actorId === userId) {
      throw new ApiException('VALIDATION_FAILED', { message: '不能禁用当前账号' });
    }
    try {
      const result = await this.prisma.$transaction(
        async (transaction) => {
          if (!(await lockUserForUpdate(transaction, userId))) {
            throw new ApiException('RESOURCE_NOT_FOUND');
          }
          const target = await transaction.user.findUnique({ where: { id: userId } });
          if (!target) throw new ApiException('RESOURCE_NOT_FOUND');
          if (target.status === UserStatus.DISABLED) {
            await this.audit.record(
              {
                actorId,
                action: 'USER_DISABLED',
                resourceType: 'User',
                resourceId: userId,
                requestId,
                metadata: { outcome: 'noop' },
              },
              transaction,
            );
            return publicUser(target);
          }

          if (target.role === UserRole.ADMIN) {
            const activeAdmins = await transaction.user.count({
              where: { role: UserRole.ADMIN, status: UserStatus.ACTIVE },
            });
            if (activeAdmins <= 1) {
              throw new ApiException('VALIDATION_FAILED', {
                message: '不能禁用最后一个可用管理员',
              });
            }
          }

          const updated = await transaction.user.update({
            where: { id: userId },
            data: { status: UserStatus.DISABLED, tokenVersion: { increment: 1 } },
          });
          await transaction.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await this.audit.record(
            {
              actorId,
              action: 'USER_DISABLED',
              resourceType: 'User',
              resourceId: userId,
              requestId,
              metadata: { outcome: 'disabled' },
            },
            transaction,
          );
          return publicUser(updated);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ApiException('VALIDATION_FAILED', { message: '用户状态已变化，请重试' });
      }
      throw error;
    }
  }

  async resetPassword(
    actorId: string,
    userId: string,
    password: string,
    requestId?: string,
  ): Promise<PublicUser> {
    assertUserId(userId);
    try {
      validatePasswordInput(password);
    } catch {
      throw new ApiException('VALIDATION_FAILED');
    }
    const passwordHash = await this.passwords.hash(password);
    const result = await this.prisma.$transaction(async (transaction) => {
      if (!(await lockUserForUpdate(transaction, userId))) {
        throw new ApiException('RESOURCE_NOT_FOUND');
      }
      const target = await transaction.user.findUnique({ where: { id: userId } });
      if (!target) throw new ApiException('RESOURCE_NOT_FOUND');
      const updated = await transaction.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      await transaction.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          actorId,
          action: 'USER_PASSWORD_RESET',
          resourceType: 'User',
          resourceId: userId,
          requestId,
          metadata: { outcome: 'reset' },
        },
        transaction,
      );
      return publicUser(updated);
    });
    return result;
  }
}

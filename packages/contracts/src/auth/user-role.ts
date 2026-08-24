/**
 * 平台用户角色契约。
 *
 * 对应产品设计第 4 节：第一版只有管理员与普通用户两种角色，不引入项目级角色、
 * 用户组或细粒度权限位。所有资源归属校验在服务端完成（见实施计划 T1.3）。
 */

import { ContractValidationError, createIssue } from '../validation/issue';
import { isMemberOf, parseEnumValue } from '../validation/enum';

/** 全部合法用户角色，顺序稳定，可直接用于下拉选项与数据库枚举。 */
export const USER_ROLES = ['ADMIN', 'USER'] as const;

/** 用户角色。 */
export type UserRole = (typeof USER_ROLES)[number];

/** 角色校验失败时使用的稳定错误码。 */
export const USER_ROLE_INVALID_CODE = 'USER_ROLE_INVALID';

/** 判断值是否为合法用户角色。 */
export function isUserRole(value: unknown): value is UserRole {
  return isMemberOf(USER_ROLES, value);
}

/**
 * 校验并返回用户角色。
 *
 * @throws {ContractValidationError} 取值不在 {@link USER_ROLES} 中。
 */
export function parseUserRole(value: unknown): UserRole {
  return parseEnumValue(USER_ROLES, value, {
    code: USER_ROLE_INVALID_CODE,
    label: 'UserRole',
  });
}

/** 判断角色是否具备管理员权限。管理员可访问全部资源。 */
export function isAdminRole(value: unknown): boolean {
  return value === 'ADMIN';
}

/**
 * 断言角色为管理员，用于服务端 Guard 之外的兜底校验。
 *
 * @throws {ContractValidationError} 角色非法或不是管理员。
 */
export function assertAdminRole(value: unknown): UserRole {
  const role = parseUserRole(value);

  if (!isAdminRole(role)) {
    throw new ContractValidationError('UserRole 校验失败', [
      createIssue(USER_ROLE_INVALID_CODE, [], '该操作要求 ADMIN 角色'),
    ]);
  }

  return role;
}

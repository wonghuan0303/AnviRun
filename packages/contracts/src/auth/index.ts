/** 认证与授权相关的公共契约。 */

export {
  USER_ROLES,
  USER_ROLE_INVALID_CODE,
  assertAdminRole,
  isAdminRole,
  isUserRole,
  parseUserRole,
} from './user-role';
export type { UserRole } from './user-role';

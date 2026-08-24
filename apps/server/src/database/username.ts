const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

/**
 * 将用户名规范化为 ASCII 小写规范形式。
 *
 * User.username 在数据库中带有同样的小写 CHECK，避免绕过 Server 直接写入大小写变体。
 */
export function normalizeUsername(username: string): string {
  const normalized = username.trim().toLowerCase();

  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error(
      'username must be 3-64 characters and contain only lowercase letters, digits, dot, underscore, or hyphen',
    );
  }

  return normalized;
}

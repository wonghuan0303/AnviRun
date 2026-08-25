import { validatePasswordInput } from '../password.service';

export interface LoginDto {
  username: string;
  password: string;
}

export interface CreateUserDto {
  username: string;
  password: string;
  role?: 'ADMIN' | 'USER';
}

export interface ResetPasswordDto {
  password: string;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('body must be an object');
  }
  return input as Record<string, unknown>;
}

export function parseLoginDto(input: unknown): LoginDto {
  const body = objectInput(input);
  if (typeof body.username !== 'string' || body.username.length > 128)
    throw new Error('username is invalid');
  if (typeof body.password !== 'string') throw new Error('password is invalid');
  validatePasswordInput(body.password);
  return { username: body.username, password: body.password };
}

export function parseCreateUserDto(input: unknown): CreateUserDto {
  const body = objectInput(input);
  if (typeof body.username !== 'string' || body.username.length > 128)
    throw new Error('username is invalid');
  if (typeof body.password !== 'string') throw new Error('password is invalid');
  validatePasswordInput(body.password);
  if (body.role !== undefined && body.role !== 'ADMIN' && body.role !== 'USER')
    throw new Error('role is invalid');
  return { username: body.username, password: body.password, role: body.role };
}

export function parseResetPasswordDto(input: unknown): ResetPasswordDto {
  const body = objectInput(input);
  if (typeof body.password !== 'string') throw new Error('password is invalid');
  validatePasswordInput(body.password);
  return { password: body.password };
}

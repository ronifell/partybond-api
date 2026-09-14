import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  sub: string;
  email: string;
  guest?: boolean;
}

export function signJwt(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: env.jwtExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.jwtSecret, options);
}

/** Short-lived token for browser guests on Squad Rescue (not a mobile account). */
export function signGuestJwt(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: '7d' };
  return jwt.sign({ ...payload, guest: true }, env.jwtSecret, options);
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, env.jwtSecret) as JwtPayload;
}

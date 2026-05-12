import type { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../utils/jwt';
import { HttpError } from '../utils/httpError';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return next(HttpError.unauthorized('Missing bearer token'));
  }
  const token = auth.slice('Bearer '.length).trim();
  try {
    const payload = verifyJwt(token);
    req.userId = payload.sub;
    req.userEmail = payload.email;
    next();
  } catch {
    next(HttpError.unauthorized('Invalid or expired token'));
  }
}

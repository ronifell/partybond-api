import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';

/**
 * Gate any route behind an authenticated admin user.
 * Must be mounted AFTER `requireAuth`, so `req.userId` is populated.
 */
export async function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.userId) return next(HttpError.unauthorized());

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, isAdmin: true, bannedAt: true },
    });

    if (!user) return next(HttpError.unauthorized('Unknown user'));
    if (user.bannedAt) return next(HttpError.forbidden('Account is restricted'));
    if (!user.isAdmin) return next(HttpError.forbidden('Admin privileges required'));

    next();
  } catch (err) {
    next(err);
  }
}

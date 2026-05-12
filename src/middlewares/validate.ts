import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';

type Source = 'body' | 'query' | 'params';

export const validate =
  (schema: ZodTypeAny, source: Source = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      return next(parsed.error);
    }
    // overwrite with parsed value so handlers get typed/coerced data
    (req as unknown as Record<string, unknown>)[source] = parsed.data;
    next();
  };

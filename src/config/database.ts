import { PrismaClient } from '@prisma/client';
import { isProd } from './env';

export const prisma = new PrismaClient({
  log: isProd ? ['error'] : ['warn', 'error'],
});

import path from 'node:path';
import dotenv from 'dotenv';

// Load `.env` from project root; override stale PM2/shell vars (e.g. wrong MAIL_PASSWORD).
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const required = (name: string, value: string | undefined, fallback?: string): string => {
  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
};

/** Trim whitespace and optional surrounding quotes from .env values. */
function cleanEnv(value: string | undefined): string {
  if (!value) return '';
  return value.trim().replace(/^["']|["']$/g, '');
}

/** Gmail app passwords are 16 chars; Google often displays them with spaces. */
function cleanAppPassword(value: string | undefined): string {
  const raw = cleanEnv(value);
  // Take only the first token — guards against pasted "password <onboarding@resend.dev>"
  const token = raw.split(/\s+/)[0] ?? '';
  return token.replace(/\s+/g, '');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? 'http://localhost:4000',
  clientOrigins: (process.env.CLIENT_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),

  jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET, 'dev-insecure-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',

  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '',

  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB ?? 5),

  mail: {
    host: cleanEnv(process.env.MAIL_HOST) || 'smtp.gmail.com',
    port: Number(cleanEnv(process.env.MAIL_PORT) || 587),
    username:
      cleanEnv(process.env.MAIL_USERNAME) || cleanEnv(process.env.MAIL_USER) || '',
    /** Gmail App Password (not your normal Gmail password). */
    password: cleanAppPassword(process.env.MAIL_PASSWORD),
    fromName: cleanEnv(process.env.MAIL_FROM_NAME) || 'Partybond',
    get from(): string {
      const user = this.username;
      const name = this.fromName;
      return user ? `${name} <${user}>` : name;
    },
    get isConfigured(): boolean {
      return !!(this.username && this.password);
    },
  },
};

export const isProd = env.nodeEnv === 'production';

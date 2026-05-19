import 'dotenv/config';

const required = (name: string, value: string | undefined, fallback?: string): string => {
  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
};

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

  /** Resend.com API key — when set, password reset emails are sent. */
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'Partybond <onboarding@resend.dev>',
  /** Deep link / web URL base for reset links (no trailing slash). */
  resetLinkBase: process.env.RESET_LINK_BASE ?? 'partybond://reset-password',
};

export const isProd = env.nodeEnv === 'production';

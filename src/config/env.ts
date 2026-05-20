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

  mail: {
    host: process.env.MAIL_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.MAIL_PORT ?? 587),
    username: process.env.MAIL_USERNAME ?? '',
    /** Gmail App Password (not your normal Gmail password). */
    password: process.env.MAIL_PASSWORD ?? '',
    fromName: process.env.MAIL_FROM_NAME ?? 'Partybond',
    get from(): string {
      const user = process.env.MAIL_USERNAME ?? '';
      const name = process.env.MAIL_FROM_NAME ?? 'Partybond';
      return user ? `${name} <${user}>` : name;
    },
    get isConfigured(): boolean {
      return !!(process.env.MAIL_USERNAME && process.env.MAIL_PASSWORD);
    },
  },
};

export const isProd = env.nodeEnv === 'production';

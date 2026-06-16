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

  google: {
    clientIds: [
      process.env.GOOGLE_WEB_CLIENT_ID,
      process.env.GOOGLE_ANDROID_CLIENT_ID,
      process.env.GOOGLE_IOS_CLIENT_ID,
    ]
      .map((id) => cleanEnv(id))
      .filter(Boolean),
  },

  /** Google Play Billing — server-side subscription verification. */
  googlePlay: {
    serviceAccountJson: cleanEnv(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON),
    packageName: cleanEnv(process.env.GOOGLE_PLAY_PACKAGE_NAME) || 'com.partybond.app',
    /** Subscription product IDs that grant premium. CSV. */
    premiumProductIds: (cleanEnv(process.env.PREMIUM_PRODUCT_IDS) || 'partybond.premium.monthly')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    get isConfigured(): boolean {
      return !!this.serviceAccountJson;
    },
  },

  /**
   * Mock billing provider — when enabled, the client can "purchase" premium
   * without going through Google Play / App Store. Useful while the real IAP
   * pipeline is being set up. Disabled by default. NEVER leave this on in a
   * production build that ships to real users.
   */
  billingMock: {
    enabled: (cleanEnv(process.env.BILLING_MOCK_ENABLED) || 'false').toLowerCase() === 'true',
    /** How many premium days the mock purchase grants per click. */
    durationDays: Math.max(
      1,
      Number(cleanEnv(process.env.BILLING_MOCK_DURATION_DAYS) || 30),
    ),
  },

  /** Referral / invite-a-friend program. */
  referral: {
    /** Base URL of the public invite landing page (e.g. https://api.partybond.com/i). */
    baseUrl: (cleanEnv(process.env.INVITE_BASE_URL) || 'http://localhost:4000/i').replace(/\/+$/, ''),
    /** Where iOS users get redirected from the landing page. */
    appStoreUrl: cleanEnv(process.env.APP_STORE_URL) || 'https://apps.apple.com/app/id0000000000',
    /** Premium days credited to the inviter when an invitee completes signup. */
    rewardDays: Math.max(0, Number(cleanEnv(process.env.REFERRAL_REWARD_DAYS) || 7)),
  },
};

export const isProd = env.nodeEnv === 'production';

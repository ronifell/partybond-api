/**
 * Verify Gmail SMTP credentials from .env (run on the same machine as the API).
 *
 *   cd Backend && npm run test:smtp
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

const envPath = path.resolve(process.cwd(), '.env');
const beforePass = process.env.MAIL_PASSWORD ?? '';

dotenv.config({ path: envPath, override: true });

function cleanEnv(value: string | undefined): string {
  if (!value) return '';
  return value.trim().replace(/^["']|["']$/g, '');
}

function cleanAppPassword(value: string | undefined): string {
  const raw = cleanEnv(value);
  return (raw.split(/\s+/)[0] ?? '').replace(/\s+/g, '');
}

const host = cleanEnv(process.env.MAIL_HOST) || 'smtp.gmail.com';
const port = Number(cleanEnv(process.env.MAIL_PORT) || 587);
const user = cleanEnv(process.env.MAIL_USERNAME) || cleanEnv(process.env.MAIL_USER);
const pass = cleanAppPassword(process.env.MAIL_PASSWORD);

if (!user || !pass) {
  console.error('Missing MAIL_USERNAME or MAIL_PASSWORD in .env');
  process.exit(1);
}

// Diagnose duplicate MAIL_PASSWORD lines in .env
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const mailPassLines = lines.filter((l) => /^\s*MAIL_PASSWORD\s*=/.test(l));
  if (mailPassLines.length > 1) {
    console.warn(`Warning: .env has ${mailPassLines.length} MAIL_PASSWORD lines. Keep only one.`);
  }
}

if (beforePass && beforePass !== pass) {
  console.warn(
    'Warning: MAIL_PASSWORD was already set in the shell/PM2 before loading .env.',
  );
  console.warn(`  Shell/PM2 length: ${beforePass.replace(/\s+/g, '').length} → .env length: ${pass.length}`);
  console.warn('  Using .env value (override: true). Restart pm2 after fixing ecosystem env.\n');
}

console.log('Testing SMTP login...');
console.log('  .env file:', envPath);
console.log('  host:', host);
console.log('  port:', port);
console.log('  user:', user);
console.log('  pass length:', pass.length, pass.length === 16 ? '✓' : '✗ expect 16');

if (pass.length !== 16) {
  console.error('\nMAIL_PASSWORD must be exactly 16 characters (Gmail App Password).');
  console.error('Run on this server:  grep MAIL_PASSWORD .env');
  console.error('Remove duplicate lines and any export MAIL_PASSWORD in ~/.bashrc or pm2 config.');
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
});

transport
  .verify()
  .then(() => {
    console.log('\nOK — Gmail accepted these credentials. Run: pm2 restart partybond-api');
    process.exit(0);
  })
  .catch((err: Error) => {
    console.error('\nFAILED —', err.message);
    console.error('\nIf length is 16 but login still fails:');
    console.error('  1. Regenerate App Password: https://myaccount.google.com/apppasswords');
    console.error('  2. Update MAIL_PASSWORD in .env (this server only)');
    console.error('  3. pm2 delete partybond-api && pm2 start … (clears old env)');
    process.exit(1);
  });

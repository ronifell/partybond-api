/**
 * Verify Gmail SMTP credentials from .env (run on the same machine as the API).
 *
 *   cd Backend && npx tsx scripts/test-smtp.ts
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const host = (process.env.MAIL_HOST ?? 'smtp.gmail.com').trim();
const port = Number((process.env.MAIL_PORT ?? '587').trim());
const user = (process.env.MAIL_USERNAME ?? process.env.MAIL_USER ?? '').trim();
const pass = (process.env.MAIL_PASSWORD ?? '').trim().replace(/\s+/g, '');

if (!user || !pass) {
  console.error('Missing MAIL_USERNAME or MAIL_PASSWORD in .env');
  process.exit(1);
}

console.log('Testing SMTP login...');
console.log('  host:', host);
console.log('  port:', port);
console.log('  user:', user);
console.log('  pass length:', pass.length, '(expect 16 for Gmail App Password)');

const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
});

transport
  .verify()
  .then(() => {
    console.log('\nOK — Gmail accepted these credentials. Restart pm2 and try forgot-password again.');
    process.exit(0);
  })
  .catch((err: Error) => {
    console.error('\nFAILED —', err.message);
    console.error('\nFix:');
    console.error('  1. Enable 2-Step Verification on the Google account');
    console.error('  2. Create a NEW App Password: https://myaccount.google.com/apppasswords');
    console.error('  3. Set MAIL_PASSWORD to 16 chars with NO spaces in .env on THIS server');
    console.error('  4. pm2 restart partybond-api');
    process.exit(1);
  });

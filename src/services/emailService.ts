import { logger } from '../utils/logger';
import { env } from '../config/env';

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const apiKey = env.resendApiKey;
  const from = env.emailFrom;

  if (!apiKey) {
    logger.info({ to, resetUrl }, 'Password reset link (set RESEND_API_KEY to send email)');
    return;
  }

  const subject = 'Reset your Partybond password';
  const html = `
    <p>Hi,</p>
    <p>We received a request to reset your Partybond password.</p>
    <p><a href="${resetUrl}">Reset your password</a></p>
    <p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>
    <p>— Partybond</p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Failed to send password reset email');
    throw new Error('Failed to send email');
  }
}

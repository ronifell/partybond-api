import { logger } from '../utils/logger';
import { env } from '../config/env';

export async function sendPasswordResetCode(to: string, code: string): Promise<void> {
  const apiKey = env.resendApiKey;
  const from = env.emailFrom;

  if (!apiKey) {
    logger.info({ to, code }, 'Password reset code (set RESEND_API_KEY to send email)');
    return;
  }

  const subject = 'Your Partybond password reset code';
  const html = `
    <p>Hi,</p>
    <p>Your password reset verification code is:</p>
    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${code}</p>
    <p>This code expires in 15 minutes. If you did not request this, you can ignore this email.</p>
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

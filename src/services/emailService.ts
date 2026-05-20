import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

function createTransporter(): Transporter | null {
  if (!env.mail.isConfigured) return null;
  return nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.port === 465,
    auth: {
      user: env.mail.username,
      pass: env.mail.password,
    },
    tls: env.mail.port === 587 ? { minVersion: 'TLSv1.2' } : undefined,
  });
}

export async function sendPasswordResetCode(to: string, code: string): Promise<void> {
  const transport = createTransporter();
  const subject = 'Your Partybond password reset code';
  const html = `
    <p>Hi,</p>
    <p>Your password reset verification code is:</p>
    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${code}</p>
    <p>This code expires in 15 minutes. If you did not request this, you can ignore this email.</p>
    <p>— Partybond</p>
  `;
  const text = `Your Partybond password reset code is: ${code}\n\nThis code expires in 15 minutes.`;

  if (!transport) {
    logger.info({ to, code }, 'Password reset code (configure MAIL_* in .env to send email)');
    return;
  }

  try {
    await transport.sendMail({
      from: env.mail.from,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to }, 'Password reset code email sent');
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'EAUTH') {
      logger.error(
        {
          to,
          username: env.mail.username,
          passLength: env.mail.password.length,
          cwd: process.cwd(),
        },
        'Gmail SMTP login failed (535). passLength must be 16. Run: npm run build && pm2 restart partybond-api --update-env',
      );
    } else {
      logger.error({ err, to }, 'Failed to send password reset email via SMTP');
    }
    throw err;
  }
}

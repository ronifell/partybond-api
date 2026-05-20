import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.mail.isConfigured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
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
  return transporter;
}

export async function sendPasswordResetCode(to: string, code: string): Promise<void> {
  const transport = getTransporter();
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
        { to, username: env.mail.username },
        'Gmail SMTP login failed (535). Use a 16-character App Password (not your normal Gmail password), ' +
          '2-Step Verification enabled, MAIL_USERNAME=full@gmail.com. Regenerate at https://myaccount.google.com/apppasswords',
      );
    } else {
      logger.error({ err, to }, 'Failed to send password reset email via SMTP');
    }
    throw err;
  }
}

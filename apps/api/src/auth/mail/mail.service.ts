import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tracer } from '../../common/observability/tracing';

export interface IMail {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative; the plain text is always sent. */
  html?: string;
  /** The body carries a secret (a one-time code): it is never written to the log, in any transport mode. */
  sensitive?: boolean;
}

export interface IMailTransport {
  send(mail: IMail): Promise<void>;
}

/** The From header for the `resend` transport; mirrors getResendSenderAddress in the web gateway (ownus/src/lib/email-service.ts). */
export function resendSender(env: NodeJS.ProcessEnv = process.env): string {
  const from = env.RESEND_FROM_EMAIL?.trim();
  if (!from) return 'Monarch Security <security@monarchsoftwares.com>';
  return from.includes('<') && from.includes('>') ? from : `Monarch Security <${from}>`;
}

/**
 * Outbound e-mail for account flows (password reset, verification, security notices).
 *
 * Transport is chosen by MAIL_TRANSPORT:
 *  - `webhook`: POST {to, subject, text} as JSON to MAIL_WEBHOOK_URL (optional bearer MAIL_WEBHOOK_TOKEN), so any
 *    provider (SES/Resend/SendGrid behind a small relay) can be plugged in without a new dependency.
 *  - `resend`: sent directly through the Resend API with RESEND_API_KEY; the sender is RESEND_FROM_EMAIL (a bare address gets the
 *    "Monarch Security" display name, the same rule the web gateway uses for its own mail).
 *  - `log` (default outside production): the message is written to the application log. Never use in production:
 *    the log would then hold live reset links. In production without a configured transport, sending fails closed
 *    (is logged as an error, the link is NOT logged) so the gap is visible instead of silently leaking tokens.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  /** Overridable in tests. */
  transport?: IMailTransport;

  constructor(private readonly config: ConfigService) {}

  async send(mail: IMail): Promise<void> {
    await this.sendChecked(mail);
  }

  /**
   * Same as send, but reports whether the message was handed to a transport. Used where the caller must tell the user about a delivery
   * failure (a verification code that never arrives). It never throws and never logs a sensitive body.
   */
  async sendChecked(mail: IMail): Promise<boolean> {
    try {
      if (this.transport) {
        await this.transport.send(mail);
        return true;
      }
      const mode = (process.env.MAIL_TRANSPORT || '').trim() || (process.env.NODE_ENV === 'production' ? 'none' : 'log');
      if (mode === 'webhook') {
        const url = process.env.MAIL_WEBHOOK_URL;
        if (!url) throw new Error('MAIL_WEBHOOK_URL is not set');
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...tracer.outboundHeaders(), // the relay is ours: the trace continues across the hop
            ...(process.env.MAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}` } : {}),
          },
          body: JSON.stringify(mail),
        });
        if (!res.ok) throw new Error(`mail webhook responded ${res.status}`);
        return true;
      }
      if (mode === 'resend') {
        const key = process.env.RESEND_API_KEY?.trim();
        if (!key) throw new Error('RESEND_API_KEY is not set');
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ from: resendSender(), to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`resend responded ${res.status}`); // the response body is not logged: it can echo the recipient
        return true;
      }
      if (mode === 'log') {
        this.logger.log(
          mail.sensitive
            ? `[mail:log] to=${mail.to} subject="${mail.subject}" (body withheld: it holds a one-time code)`
            : `[mail:log] to=${mail.to} subject="${mail.subject}"\n${mail.text}`,
        );
        return !mail.sensitive; // a code that was only logged was not delivered to anyone
      }
      this.logger.error(`No mail transport configured (MAIL_TRANSPORT); message "${mail.subject}" to ${mail.to} was not sent`);
      return false;
    } catch (err) {
      // Never let a mail failure change the API response (that would leak whether an account exists).
      this.logger.error(`Mail send failed for "${mail.subject}": ${(err as Error).message}`);
      return false;
    }
  }

  /** Base URL of the web app that hosts the reset / verify pages. */
  webUrl(): string {
    return (process.env.WEB_APP_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  }
}

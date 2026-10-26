import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveSecret } from '../../../config/secrets';
import * as crypto from 'crypto';

export interface IOAuthStatePayload {
  provider: string;
  linkUserId?: string;
  nonce: string;
  codeVerifier?: string;
  timestamp: number;
}

@Injectable()
export class OAuthStateService {
  private readonly logger = new Logger(OAuthStateService.name);
  private readonly secret: string;
  private readonly stateStore = new Map<string, IOAuthStatePayload>();
  /** Nonces of states this process has accepted once (see verifyState). */
  private readonly usedNonces = new Set<string>();

  constructor(private readonly configService: ConfigService) {
    // the access secret from the environment; never a built-in value (a random per-process key outside production)
    this.secret = this.configService.get<string>('JWT_ACCESS_SECRET') || resolveSecret('JWT_ACCESS_SECRET');
  }

  /**
   * Generates PKCE code_verifier and code_challenge (S256)
   */
  generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }

  /**
   * Generates a signed, tamper-proof state token with embedded PKCE verifier
   */
  generateState(provider: string, linkUserId?: string): { state: string; codeVerifier: string; codeChallenge: string } {
    const { codeVerifier, codeChallenge } = this.generatePKCE();
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    const payload: IOAuthStatePayload = {
      provider,
      linkUserId,
      nonce,
      codeVerifier,
      timestamp,
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(payloadBase64)
      .digest('base64url');

    const state = `${payloadBase64}.${signature}`;
    this.stateStore.set(state, payload);

    // Clean up older states after 15 minutes
    setTimeout(() => this.stateStore.delete(state), 15 * 60 * 1000);

    return { state, codeVerifier, codeChallenge };
  }

  /**
   * Validates state signature, expiration (10m), and retrieves state payload
   */
  verifyState(state: string): { valid: boolean; payload?: IOAuthStatePayload } {
    if (!state || !state.includes('.')) {
      return { valid: false };
    }

    const [payloadBase64, signature] = state.split('.');
    const expectedSignature = crypto
      .createHmac('sha256', this.secret)
      .update(payloadBase64)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expectedSigBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
      this.logger.warn('OAuth state HMAC signature mismatch - possible tampering');
      return { valid: false };
    }

    try {
      const payload: IOAuthStatePayload = JSON.parse(
        Buffer.from(payloadBase64, 'base64url').toString('utf8'),
      );

      // Verify expiration (max 10 minutes)
      const maxAgeMs = 10 * 60 * 1000;
      if (Date.now() - payload.timestamp > maxAgeMs) {
        this.logger.warn('OAuth state token expired');
        return { valid: false };
      }

      // One-time use. The signature and expiry above already prove the state was issued by us, so it does not matter WHICH process issued it:
      // on a serverless host (Vercel) the start of sign-in and the return from Google routinely run on different instances, and any cold
      // start empties this process's memory, so requiring the state to be in this process's store rejected genuine sign-ins. Each process
      // therefore remembers the nonces it has seen used and refuses a second use; a replay that lands on another instance still needs a
      // Google authorization code, which Google itself accepts only once.
      if (this.usedNonces.has(payload.nonce)) {
        this.logger.warn('OAuth state token has already been consumed (replay prevented)');
        return { valid: false };
      }
      this.usedNonces.add(payload.nonce);
      setTimeout(() => this.usedNonces.delete(payload.nonce), 15 * 60 * 1000).unref?.();
      this.stateStore.delete(state);

      return { valid: true, payload };
    } catch (err: any) {
      this.logger.error(`Error parsing state payload: ${err.message}`);
      return { valid: false };
    }
  }
}

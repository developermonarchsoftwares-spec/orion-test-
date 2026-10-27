import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IOAuthProvider, IOAuthTokens, IOAuthUserProfile } from '../interfaces/oauth-provider.interface';
import { BusinessException } from '../../../common/errors/business.exception';
import { oauthSimulationAllowed } from '../oauth-simulation';
import { defaultOAuthCallbackUrl } from '../oauth-urls';

@Injectable()
export class GoogleOAuthProvider implements IOAuthProvider {
  readonly name = 'GOOGLE';
  private readonly logger = new Logger(GoogleOAuthProvider.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: string;

  private sanitizeValue(val?: string, keyPrefix?: string): string {
    if (!val) return '';
    let cleaned = String(val).replace(/[\r\n]+/g, '').trim();
    cleaned = cleaned.replace(/^["'`]|["'`]$/g, '').trim();
    if (keyPrefix && cleaned.toLowerCase().startsWith(keyPrefix.toLowerCase() + '=')) {
      cleaned = cleaned.substring(keyPrefix.length + 1).trim();
    }
    cleaned = cleaned.replace(/^[A-Za-z0-9_]+=\s*/, '').trim();
    return cleaned.replace(/^["'`]|["'`]$/g, '').trim();
  }

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.sanitizeValue(this.configService.get<string>('GOOGLE_CLIENT_ID'), 'GOOGLE_CLIENT_ID');
    this.clientSecret = this.sanitizeValue(this.configService.get<string>('GOOGLE_CLIENT_SECRET'), 'GOOGLE_CLIENT_SECRET');
    let rawCallback = this.sanitizeValue(this.configService.get<string>('GOOGLE_CALLBACK_URL'), 'GOOGLE_CALLBACK_URL');
    this.callbackUrl = rawCallback || defaultOAuthCallbackUrl('google');

    const isConfig = this.isConfigured();
    const suffix = isConfig && this.clientId.length >= 4 
      ? `****${this.clientId.slice(-4)}` 
      : '(not configured)';
    this.logger.log(`Google OAuth client configured: ${isConfig} (Client ID suffix: ${suffix})`);
  }

  isConfigured(): boolean {
    return (
      Boolean(this.clientId) &&
      Boolean(this.clientSecret) &&
      !this.clientId.includes('demo-') &&
      !this.clientId.includes('your-')
    );
  }

  getAuthorizationUrl(state: string, codeChallenge?: string): string {
    if (!this.clientId || this.clientId === 'demo-google-client-id' || this.clientId.includes('your-')) {
      throw new BusinessException(
        'Google OAuth client ID is not configured. Please define GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in apps/api/.env',
        'GOOGLE_CLIENT_ID_MISSING',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!this.callbackUrl) {
      throw new BusinessException(
        'Google OAuth callback URL is not configured. Please define GOOGLE_CALLBACK_URL (or WEB_APP_URL).',
        'GOOGLE_CALLBACK_URL_MISSING',
        HttpStatus.BAD_REQUEST,
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'select_account',
    });

    if (codeChallenge) {
      params.append('code_challenge', codeChallenge);
      params.append('code_challenge_method', 'S256');
    }

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier?: string): Promise<IOAuthTokens> {
    // Simulation exists for automated tests only (see oauth-simulation.ts); it never runs elsewhere.
    if (oauthSimulationAllowed() && (code.startsWith('sim_google_') || !this.isConfigured())) {
      const emailPart = code.startsWith('sim_google_') ? code.replace('sim_google_', '') : '';
      this.logger.log('Using simulation mode for Google OAuth exchange (test environment)');
      return {
        accessToken: `google_sim_access_${emailPart || Date.now()}`,
        idToken: `google_sim_id_${Date.now()}`,
        tokenType: 'Bearer',
        expiresIn: 3600,
      };
    }
    if (code.startsWith('sim_google_') || !this.isConfigured()) {
      throw new BusinessException('Google sign-in is not available', 'GOOGLE_OAUTH_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }

    try {
      const bodyParams: Record<string, string> = {
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.callbackUrl,
        grant_type: 'authorization_code',
      };

      if (codeVerifier) {
        bodyParams.code_verifier = codeVerifier;
      }

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(bodyParams).toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(`Google token exchange failed: ${errText}`);
        throw new BusinessException('Failed to exchange authorization code with Google', 'GOOGLE_OAUTH_ERROR');
      }

      const data = await res.json();
      return {
        accessToken: data.access_token,
        idToken: data.id_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        tokenType: data.token_type,
      };
    } catch (err: any) {
      this.logger.error(`Google code exchange error: ${err.message}`);
      throw err;
    }
  }

  async getUserProfile(accessToken: string, idToken?: string): Promise<IOAuthUserProfile> {
    if (accessToken.startsWith('google_sim_access_')) {
      if (!oauthSimulationAllowed()) {
        throw new BusinessException('Google sign-in is not available', 'GOOGLE_OAUTH_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
      }
      const simEmail = accessToken.replace('google_sim_access_', '');
      const email = (simEmail.includes('@') ? simEmail : null) || this.configService.get<string>('SIM_GOOGLE_EMAIL') || 'user.google@orion.ai';
      const providerId = `google_user_${Buffer.from(email).toString('hex').slice(0, 16)}`;
      return {
        provider: 'GOOGLE',
        providerId,
        email,
        firstName: 'Google',
        lastName: 'User',
        displayName: 'Google User',
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
        isEmailVerified: true,
      };
    }

    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        throw new BusinessException('Failed to retrieve user profile from Google', 'GOOGLE_PROFILE_ERROR');
      }

      const profile = await res.json();

      return {
        provider: 'GOOGLE',
        providerId: profile.sub,
        email: profile.email.toLowerCase().trim(),
        firstName: profile.given_name || profile.name?.split(' ')[0] || 'User',
        lastName: profile.family_name || profile.name?.split(' ').slice(1).join(' ') || '',
        displayName: profile.name || profile.email.split('@')[0],
        avatarUrl: profile.picture,
        isEmailVerified: Boolean(profile.email_verified),
        rawProfile: profile,
      };
    } catch (err: any) {
      this.logger.error(`Google profile fetch error: ${err.message}`);
      throw err;
    }
  }
}

import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IOAuthProvider, IOAuthTokens, IOAuthUserProfile } from '../interfaces/oauth-provider.interface';
import { BusinessException } from '../../../common/errors/business.exception';
import { oauthSimulationAllowed } from '../oauth-simulation';
import { defaultOAuthCallbackUrl } from '../oauth-urls';

@Injectable()
export class MicrosoftOAuthProvider implements IOAuthProvider {
  readonly name = 'MICROSOFT';
  private readonly logger = new Logger(MicrosoftOAuthProvider.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenantId: string;
  private readonly callbackUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = (this.configService.get<string>('MICROSOFT_CLIENT_ID') || '')
      .trim()
      .replace(/^["']|["']$/g, '');
    this.clientSecret = (this.configService.get<string>('MICROSOFT_CLIENT_SECRET') || '')
      .trim()
      .replace(/^["']|["']$/g, '');
    this.tenantId = (this.configService.get<string>('MICROSOFT_TENANT_ID') || 'common')
      .trim()
      .replace(/^["']|["']$/g, '');
    this.callbackUrl = (
      this.configService.get<string>('MICROSOFT_CALLBACK_URL') ||
      defaultOAuthCallbackUrl('microsoft')
    )
      .trim()
      .replace(/^["']|["']$/g, '');

    const isConfig = this.isConfigured();
    const suffix = isConfig && this.clientId.length >= 4 
      ? `****${this.clientId.slice(-4)}` 
      : '(not configured)';
    this.logger.log(`Microsoft OAuth client configured: ${isConfig} (Client ID suffix: ${suffix})`);
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
    if (!this.clientId || this.clientId === 'demo-microsoft-client-id' || this.clientId.includes('your-')) {
      throw new BusinessException(
        'Microsoft OAuth client ID is not configured. Please define MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in apps/api/.env',
        'MICROSOFT_CLIENT_ID_MISSING',
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.callbackUrl,
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state,
      prompt: 'select_account',
    });

    if (codeChallenge) {
      params.append('code_challenge', codeChallenge);
      params.append('code_challenge_method', 'S256');
    }

    return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier?: string): Promise<IOAuthTokens> {
    // Simulation exists for automated tests only (see oauth-simulation.ts); it never runs elsewhere.
    if (oauthSimulationAllowed() && (code.startsWith('sim_ms_') || !this.isConfigured())) {
      const emailPart = code.startsWith('sim_ms_') ? code.replace('sim_ms_', '') : '';
      this.logger.log('Using simulation mode for Microsoft OAuth exchange (test environment)');
      return {
        accessToken: `ms_sim_access_${emailPart || Date.now()}`,
        idToken: `ms_sim_id_${Date.now()}`,
        tokenType: 'Bearer',
        expiresIn: 3600,
      };
    }
    if (code.startsWith('sim_ms_') || !this.isConfigured()) {
      throw new BusinessException('Microsoft sign-in is not available', 'MICROSOFT_OAUTH_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }

    try {
      const bodyParams: Record<string, string> = {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
        grant_type: 'authorization_code',
        scope: 'openid profile email User.Read',
      };

      if (codeVerifier) {
        bodyParams.code_verifier = codeVerifier;
      }

      const res = await fetch(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(bodyParams).toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger.error(`Microsoft token exchange failed: ${errText}`);
        throw new BusinessException('Failed to exchange authorization code with Microsoft', 'MICROSOFT_OAUTH_ERROR');
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
      this.logger.error(`Microsoft code exchange error: ${err.message}`);
      throw err;
    }
  }

  async getUserProfile(accessToken: string, idToken?: string): Promise<IOAuthUserProfile> {
    if (accessToken.startsWith('ms_sim_access_')) {
      if (!oauthSimulationAllowed()) {
        throw new BusinessException('Microsoft sign-in is not available', 'MICROSOFT_OAUTH_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
      }
      const simEmail = accessToken.replace('ms_sim_access_', '');
      const email = (simEmail.includes('@') ? simEmail : null) || this.configService.get<string>('SIM_MS_EMAIL') || 'user.microsoft@orion.ai';
      const providerId = `ms_entra_user_${Buffer.from(email).toString('hex').slice(0, 16)}`;
      return {
        provider: 'MICROSOFT',
        providerId,
        email,
        firstName: 'Microsoft',
        lastName: 'User',
        displayName: 'Microsoft Enterprise User',
        avatarUrl: undefined,
        isEmailVerified: true,
      };
    }

    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        throw new BusinessException('Failed to retrieve user profile from Microsoft Graph', 'MICROSOFT_PROFILE_ERROR');
      }

      const profile = await res.json();
      const email = (profile.mail || profile.userPrincipalName || '').toLowerCase().trim();

      return {
        provider: 'MICROSOFT',
        providerId: profile.id,
        email,
        firstName: profile.givenName || profile.displayName?.split(' ')[0] || 'User',
        lastName: profile.surname || profile.displayName?.split(' ').slice(1).join(' ') || '',
        displayName: profile.displayName || email.split('@')[0],
        avatarUrl: undefined,
        isEmailVerified: true,
        rawProfile: profile,
      };
    } catch (err: any) {
      this.logger.error(`Microsoft profile fetch error: ${err.message}`);
      throw err;
    }
  }
}

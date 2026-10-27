import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { OAuthService } from './oauth.service';
import { Public, CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { IJwtPayload } from '@orion/shared';
import { Throttle } from '@nestjs/throttler';
import { OAuthProviderDto, OAuthTokenDto } from './dto/oauth.dto';
import { oauthFrontendUrl } from './oauth-urls';

@ApiTags('OAuth & Enterprise Identity')
@Controller('auth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly oauthService: OAuthService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl = oauthFrontendUrl({ ...process.env, FRONTEND_URL: this.configService.get<string>('FRONTEND_URL') ?? process.env.FRONTEND_URL });
  }

  @Public()
  @Get('google')
  @ApiOperation({ summary: 'Initiate Google OAuth 2.0 authorization redirect' })
  async googleAuth(@Res() res: Response) {
    try {
      const url = this.oauthService.getAuthorizationUrl('google');
      return res.redirect(url);
    } catch (err: any) {
      this.logger.error(`Failed to initiate Google OAuth: ${err.message}`);
      return res.redirect(
        `${this.frontendUrl}/login?error=${encodeURIComponent(
          err.message || 'Google OAuth is not configured. Please define GOOGLE_CLIENT_ID in apps/api/.env',
        )}`,
      );
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('google/callback')
  @ApiOperation({ summary: 'Handle Google OAuth 2.0 authorization callback' })
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect(
        `${this.frontendUrl}/login?error=${encodeURIComponent('Google sign-in was cancelled or denied.')}`,
      );
    }

    try {
      const userAgent = req.headers['user-agent'];
      const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string);

      const result = await this.oauthService.handleCallback('google', code, state, {
        userAgent,
        ipAddress,
      });

      const redirectUrl = `${this.frontendUrl}/auth/callback?accessToken=${result.tokens.accessToken}&refreshToken=${result.tokens.refreshToken}&provider=google&isNewUser=${result.isNewUser}`;
      return res.redirect(redirectUrl);
    } catch (err: any) {
      const errorMsg = encodeURIComponent(err.message || 'Google authentication failed');
      return res.redirect(`${this.frontendUrl}/login?error=${errorMsg}`);
    }
  }

  @Public()
  @Get('microsoft')
  @ApiOperation({ summary: 'Initiate Microsoft Entra ID OAuth authorization redirect' })
  async microsoftAuth(@Res() res: Response) {
    try {
      const url = this.oauthService.getAuthorizationUrl('microsoft');
      return res.redirect(url);
    } catch (err: any) {
      this.logger.error(`Failed to initiate Microsoft OAuth: ${err.message}`);
      return res.redirect(
        `${this.frontendUrl}/login?error=${encodeURIComponent(
          err.message || 'Microsoft OAuth is not configured. Please define MICROSOFT_CLIENT_ID in apps/api/.env',
        )}`,
      );
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('microsoft/callback')
  @ApiOperation({ summary: 'Handle Microsoft Entra ID authorization callback' })
  async microsoftCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      return res.redirect(
        `${this.frontendUrl}/login?error=${encodeURIComponent('Microsoft sign-in was cancelled or denied.')}`,
      );
    }

    try {
      const userAgent = req.headers['user-agent'];
      const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string);

      const result = await this.oauthService.handleCallback('microsoft', code, state, {
        userAgent,
        ipAddress,
      });

      const redirectUrl = `${this.frontendUrl}/auth/callback?accessToken=${result.tokens.accessToken}&refreshToken=${result.tokens.refreshToken}&provider=microsoft&isNewUser=${result.isNewUser}`;
      return res.redirect(redirectUrl);
    } catch (err: any) {
      const errorMsg = encodeURIComponent(err.message || 'Microsoft authentication failed');
      return res.redirect(`${this.frontendUrl}/login?error=${errorMsg}`);
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('oauth/token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Direct JSON exchange endpoint for OAuth code & state' })
  async exchangeOAuthToken(
    @Body() body: OAuthTokenDto,
    @Req() req: Request,
  ) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string);

    return this.oauthService.handleCallback(body.provider, body.code, body.state, {
      userAgent,
      ipAddress,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('link-provider')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate OAuth account linking for current authenticated user' })
  async linkProvider(
    @CurrentUser() user: IJwtPayload,
    @Body() body: OAuthProviderDto,
  ) {
    const authUrl = this.oauthService.getAuthorizationUrl(body.provider, user.sub);
    return { authUrl };
  }

  @UseGuards(JwtAuthGuard)
  @Post('unlink-provider')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlink an identity provider from current account' })
  async unlinkProvider(
    @CurrentUser() user: IJwtPayload,
    @Body() body: OAuthProviderDto,
    @Req() req: Request,
  ) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string);

    const normalizedProvider = body.provider.toUpperCase() as 'GOOGLE' | 'MICROSOFT';
    return this.oauthService.unlinkProvider(user.sub, normalizedProvider, {
      userAgent,
      ipAddress,
    });
  }
}

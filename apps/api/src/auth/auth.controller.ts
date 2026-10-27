import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './services/auth.service';
import { EmailOtpService } from './services/email-otp.service';
import { CaptchaService } from './captcha/captcha.service';
import { UserService } from '../modules/user/user.service';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  ResendVerificationDto,
  MfaLoginDto,
  MfaCodeDto,
  DisableMfaDto,
  LogoutDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { ChangePasswordDto } from '../modules/user/dto/user.dto';
import { Public, CurrentUser } from './decorators';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { IJwtPayload } from '@orion/shared';
import { Throttle } from '@nestjs/throttler';
import { clientIpOf } from '../modules/traffic/client-ip';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
    private readonly emailOtp: EmailOtpService,
    private readonly captcha: CaptchaService,
  ) {}

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user session & profile' })
  @ApiResponse({ status: 200, description: 'Current authenticated user profile and wallet' })
  async getCurrentUser(@CurrentUser() user: IJwtPayload) {
    return this.userService.getProfile(user.sub);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change account password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  async changePassword(
    @CurrentUser() user: IJwtPayload,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.userService.changePassword(user.sub, dto);
  }

  @Public()
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'E-mail a 6-digit verification code to the address a new user typed (also used to resend)' })
  @ApiResponse({ status: 200, description: 'Generic confirmation; identical whether or not the address already has an account' })
  @ApiResponse({ status: 429, description: 'Resend cooldown, daily or network limit' })
  @ApiResponse({ status: 503, description: 'The e-mail could not be handed to the mail provider' })
  async sendOtp(@Body() dto: SendOtpDto, @Req() req: Request) {
    await this.captcha.assertHuman(dto.captchaToken, clientIpOf(req));
    return this.emailOtp.send(dto.email, dto.purpose, { userAgent: req.headers['user-agent'], ipAddress: clientIpOf(req) });
  }

  @Public()
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check the code; on success returns a one-time proof that registration must present' })
  @ApiResponse({ status: 200, description: 'Verified; no session is created' })
  @ApiResponse({ status: 400, description: 'Incorrect, expired or already used code' })
  @ApiResponse({ status: 429, description: 'Attempt limit reached' })
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.emailOtp.verify(dto.email, dto.otp, dto.purpose, { userAgent: req.headers['user-agent'], ipAddress: clientIpOf(req) });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new customer account' })
  @ApiResponse({ status: 201, description: 'User successfully registered and onboarded' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = clientIpOf(req);
    return this.authService.register(dto, { userAgent, ipAddress });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate user with email and password' })
  @ApiResponse({ status: 200, description: 'JWT Token Pair and User Profile' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    await this.captcha.assertHuman(dto.captchaToken, clientIpOf(req));
    const userAgent = req.headers['user-agent'];
    const ipAddress = clientIpOf(req);
    return this.authService.login(dto, { userAgent, ipAddress });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh expired access token using refresh token' })
  @ApiResponse({ status: 200, description: 'New JWT Token Pair' })
  @ApiResponse({ status: 401, description: 'Invalid or revoked refresh token' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = clientIpOf(req);
    return this.authService.refreshTokens(dto.refreshToken, { userAgent, ipAddress });
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke active session' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(
    @CurrentUser() user: IJwtPayload,
    @Body() body?: LogoutDto,
  ) {
    await this.authService.logout(body?.refreshToken, user?.sub);
    return { success: true, message: 'Logged out successfully' };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset instructions' })
  @ApiResponse({ status: 200, description: 'Reset link generated' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset account password with token' })
  @ApiResponse({ status: 200, description: 'Password reset confirmed' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify user email with verification token' })
  @ApiResponse({ status: 200, description: 'Email confirmed' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-send the e-mail verification link' })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.email);
  }

  // ---- MFA ----

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('mfa/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a login that requires MFA (TOTP code or recovery code)' })
  async mfaLogin(@Body() dto: MfaLoginDto, @Req() req: Request) {
    const userAgent = req.headers['user-agent'];
    const ipAddress = clientIpOf(req);
    return this.authService.completeMfaLogin(dto, { userAgent, ipAddress });
  }

  @Get('mfa/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'MFA status and remaining recovery codes' })
  async mfaStatus(@CurrentUser() user: IJwtPayload) {
    return this.authService.mfaStatus(user.sub);
  }

  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Begin MFA enrolment: returns the TOTP secret and otpauth URL' })
  async mfaSetup(@CurrentUser() user: IJwtPayload) {
    return this.authService.beginMfaSetup(user.sub);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm enrolment with a code; returns one-time recovery codes (shown once)' })
  async mfaEnable(@CurrentUser() user: IJwtPayload, @Body() dto: MfaCodeDto) {
    return this.authService.enableMfa(user.sub, dto.code);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable MFA (password + code or recovery code)' })
  async mfaDisable(@CurrentUser() user: IJwtPayload, @Body() dto: DisableMfaDto) {
    return this.authService.disableMfa(user.sub, dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Regenerate recovery codes (invalidates the previous set)' })
  async mfaRecoveryCodes(@CurrentUser() user: IJwtPayload, @Body() dto: MfaCodeDto) {
    return this.authService.regenerateRecoveryCodes(user.sub, dto.code);
  }

  // ---- Sessions across devices ----

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List devices/sessions currently signed in' })
  async sessions(@CurrentUser() user: IJwtPayload) {
    return this.authService.listSessions(user.sub);
  }

  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of every device immediately (including this one)' })
  async revokeAllSessions(@CurrentUser() user: IJwtPayload) {
    return this.authService.revokeAllSessions(user.sub);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one session' })
  async revokeSession(@CurrentUser() user: IJwtPayload, @Param('id') id: string) {
    return this.authService.revokeSession(user.sub, id);
  }
}

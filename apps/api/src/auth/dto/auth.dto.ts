import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsObject, IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

/* Bodies that used to be inline types, which the validation pipe cannot check: a number or object where text was expected reached the code and was a 500.
   Fields stay optional so the controllers' own "please provide ..." answers for a missing value are unchanged. */
export class AdminSendOtpDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(254) email?: string;
}

export class AdminVerifyOtpDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) otp?: string;
}

export class LogoutDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4096) refreshToken?: string;
}

/** Sign-up e-mail verification. The service normalises and validates the values itself so every failure uses the same error shape. */
export class SendOtpDto {
  @ApiProperty({ example: 'director@company.in' }) @IsString() @MaxLength(254) email!: string;
  @ApiPropertyOptional({ example: 'REGISTER' }) @IsOptional() @IsString() @MaxLength(32) purpose?: string;
  @ApiPropertyOptional({ description: 'Turnstile CAPTCHA token from the browser; required when the server has a CAPTCHA secret configured' })
  @IsOptional() @IsString() @MaxLength(4096) captchaToken?: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'director@company.in' }) @IsString() @MaxLength(254) email!: string;
  @ApiProperty({ example: '123456', description: 'The 6-digit code from the e-mail (spaces and a dash are ignored)' }) @IsString() @MaxLength(16) otp!: string;
  @ApiPropertyOptional({ example: 'REGISTER' }) @IsOptional() @IsString() @MaxLength(32) purpose?: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'director@company.in', description: 'User work email' })
  @IsEmail({}, { message: 'Must be a valid email address' })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'P@ssword123!', description: 'Strong user password (min 8 characters)' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password must not exceed 128 characters' })
  password!: string;

  @ApiProperty({ example: 'Alex', description: 'First name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Vance', description: 'Last name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({ example: 'Alex Vance', description: 'User display name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({ example: 'Acme Corp', description: 'Organization / Company name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  organizationName?: string;

  @ApiPropertyOptional({ example: '+1-555-0199', description: 'Contact phone number' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @ApiPropertyOptional({ description: 'One-time proof returned by POST /auth/verify-otp for this exact email address. Required for every new account.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  verificationToken?: string;

  @ApiPropertyOptional({ description: 'Explicit consent choices from the sign-up form: { ACCOUNT_SERVICE: true (required in production), PRODUCT_UPDATES?: boolean, MARKETING?: boolean }. Recorded in the consent ledger with the account.' })
  @IsOptional()
  @IsObject()
  consents?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Honeypot: a hidden form field that real users never fill. Leave it empty or omit it.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'director@company.in', description: 'User email' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'P@ssword123!', description: 'User password' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({ description: 'Honeypot: a hidden form field that real users never fill. Leave it empty or omit it.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @ApiPropertyOptional({ description: 'Turnstile CAPTCHA token from the browser; required when the server has a CAPTCHA secret configured' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  captchaToken?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Valid refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'director@company.in', description: 'Registered user email' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiPropertyOptional({ description: 'Cloudflare Turnstile token; checked when the deployment has a Turnstile secret.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  captchaToken?: string;

  @ApiPropertyOptional({ description: 'Honeypot: a hidden form field that real users never fill. Leave it empty or omit it.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Password reset token from email' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ example: 'NewSecret123!', description: 'New password' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password must not exceed 128 characters' })
  newPassword!: string;

  @ApiPropertyOptional({ description: 'Honeypot: a hidden form field that real users never fill. Leave it empty or omit it.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Verification token from email' })
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'director@company.in', description: 'Registered user email' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}

export class MfaLoginDto {
  @ApiProperty({ description: 'mfaToken returned by POST /auth/login when MFA is required' })
  @IsString()
  @IsNotEmpty()
  mfaToken!: string;

  @ApiPropertyOptional({ example: '123456', description: '6-digit code from the authenticator app' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  @ApiPropertyOptional({ example: 'ABCDE-12345', description: 'One-time recovery code (use when the device is lost)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
}

export class MfaCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit code from the authenticator app' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  code!: string;
}

export class DisableMfaDto {
  @ApiPropertyOptional({ description: 'Current password (required when the account has one)' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  @ApiPropertyOptional({ example: 'ABCDE-12345' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
}

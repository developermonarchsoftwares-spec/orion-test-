import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { PasswordService } from './services/password.service';
import { AuthTokenService } from './services/auth-token.service';
import { AuthService } from './services/auth.service';
import { EmailOtpService } from './services/email-otp.service';
import { CaptchaService } from './captcha/captcha.service';
import { AuthController } from './auth.controller';
import { AdminAuthController } from './admin-auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthenticationMiddleware } from './auth.middleware';
import { MailService } from './mail/mail.service';
import { TokenCleanupService } from './services/token-cleanup.service';
import { UserModule } from '../modules/user/user.module';

@Global()
@Module({
  imports: [
    UserModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: configService.get<string>('jwt.accessExpiresIn', '15m') as any,
          issuer: configService.get<string>('jwt.issuer', 'orion-api'),
          audience: configService.get<string>('jwt.audience', 'orion-client'),
        },
        // explicit allowlist: only the algorithm we sign with is accepted, never whatever the token header claims
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController, AdminAuthController],
  providers: [
    PasswordService,
    AuthTokenService,
    MailService,
    TokenCleanupService,
    EmailOtpService,
    CaptchaService,
    AuthService,
    JwtStrategy,
    JwtRefreshStrategy,
    JwtAuthGuard,
    JwtRefreshGuard,
    RolesGuard,
    AuthenticationMiddleware,
  ],
  exports: [
    EmailOtpService,
    CaptchaService,
    MailService,
    PasswordService,
    AuthTokenService,
    AuthService,
    JwtModule,
    PassportModule,
    JwtStrategy,
    JwtRefreshStrategy,
    JwtAuthGuard,
    JwtRefreshGuard,
    RolesGuard,
    AuthenticationMiddleware,
  ],
})
export class AuthModule {}

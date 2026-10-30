import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../auth/decorators';
import { CaptchaService } from '../../auth/captcha/captcha.service';
import { clientIpOf } from '../traffic/client-ip';
import { ConfirmRightsRequestDto, CreateRightsRequestDto } from './dto/rights-request.dto';
import { RightsRequestService } from './rights-request.service';

/** Public (no login) intake for DPDP Act requests. Strictly rate limited; the Turnstile check applies when the deployment has a secret. */
@ApiTags('Privacy')
@Controller('privacy-requests')
export class RightsRequestController {
  constructor(
    private readonly rights: RightsRequestService,
    private readonly captcha: CaptchaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit a data-rights request (access, correction, erasure, withdrawal of consent, grievance, nomination)' })
  async create(@Body() dto: CreateRightsRequestDto, @Req() req: Request) {
    const ip = clientIpOf(req);
    await this.captcha.assertHuman(dto.captchaToken, ip);
    return this.rights.create(dto, { ip, userAgent: (req.headers['user-agent'] as string) ?? null });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an erasure request with the secret from the e-mail; the address is then removed from company contacts' })
  verify(@Body() dto: ConfirmRightsRequestDto, @Req() req: Request) {
    return this.rights.verifyErasure(dto.reference, dto.token, { ip: clientIpOf(req), userAgent: (req.headers['user-agent'] as string) ?? null });
  }
}

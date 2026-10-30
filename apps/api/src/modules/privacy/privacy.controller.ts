import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { IJwtPayload, UserRole } from '@orion/shared';
import { CurrentUser, Roles } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { clientIpOf } from '../traffic/client-ip';
import { RequestDeletionDto, SetConsentDto } from './dto/privacy.dto';
import { DecideRightsRequestDto } from './dto/rights-request.dto';
import { IRequestContext, PrivacyService } from './privacy.service';
import { RightsRequestService } from './rights-request.service';

const ctxOf = (req: Request): IRequestContext => ({ ip: clientIpOf(req), userAgent: (req.headers['user-agent'] as string) ?? null });

@ApiTags('Privacy')
@ApiBearerAuth()
@Controller('privacy')
@UseGuards(JwtAuthGuard)
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly rights: RightsRequestService,
  ) {}

  @Get('consents')
  @ApiOperation({ summary: 'Your current consent choices and the policy version they apply to' })
  consents(@CurrentUser() user: IJwtPayload) {
    return this.privacy.getConsents(user.sub);
  }

  @Put('consents')
  @ApiOperation({ summary: 'Grant or withdraw consent for one purpose (recorded in an append-only ledger)' })
  setConsent(@CurrentUser() user: IJwtPayload, @Body() dto: SetConsentDto, @Req() req: Request) {
    return this.privacy.setConsent(user.sub, dto.purpose, dto.granted, ctxOf(req));
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  @ApiOperation({ summary: 'Download all personal data we hold about you as JSON (GDPR Art. 15/20, CCPA right to know)' })
  async export(@CurrentUser() user: IJwtPayload, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const data = await this.privacy.exportData(user.sub, ctxOf(req));
    res.setHeader('Content-Disposition', `attachment; filename="orion-data-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  }

  @Get('requests')
  @ApiOperation({ summary: 'Your export and deletion requests' })
  requests(@CurrentUser() user: IJwtPayload) {
    return this.privacy.listRequests(user.sub);
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @ApiOperation({ summary: 'Request account erasure (runs after a 7-day cooling-off period; GDPR Art. 17, CCPA right to delete)' })
  requestDeletion(@CurrentUser() user: IJwtPayload, @Body() dto: RequestDeletionDto, @Req() req: Request) {
    return this.privacy.requestDeletion(user.sub, dto.confirmEmail, dto.password, ctxOf(req));
  }

  @Delete('delete')
  @ApiOperation({ summary: 'Cancel a pending account erasure' })
  cancelDeletion(@CurrentUser() user: IJwtPayload, @Req() req: Request) {
    return this.privacy.cancelDeletion(user.sub, ctxOf(req));
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @Get('admin/requests')
  @ApiOperation({ summary: 'Open data-subject requests, soonest statutory deadline first' })
  adminRequests() {
    return this.privacy.adminOpenRequests();
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @Get('admin/rights-requests')
  @ApiOperation({ summary: 'Open DPDP Data Principal requests from the public form, soonest deadline first' })
  adminRightsRequests(@Query('closed') closed?: string) {
    return this.rights.listOpen(closed === 'true');
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @Get('admin/rights-requests/:reference')
  @ApiOperation({ summary: 'One DPDP request with where the address appears in Orion (counts and names of matching people)' })
  adminRightsRequest(@Param('reference') reference: string) {
    return this.rights.detail(reference);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @Post('admin/rights-requests/:reference/decision')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Ask the requester for information, complete the request or reject it; the requester is told by e-mail first' })
  decideRightsRequest(@CurrentUser() admin: IJwtPayload, @Param('reference') reference: string, @Body() dto: DecideRightsRequestDto, @Req() req: Request) {
    return this.rights.decide(reference, admin.sub, dto, ctxOf(req));
  }
}

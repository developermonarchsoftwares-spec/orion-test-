import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { UnlockService } from './unlock.service';
import { UnlockBusinessDto } from './dto/unlock.dto';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { IJwtPayload } from '@orion/shared';
import { boundedPage } from '../../common/utils/pagination.util';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Lead Unlock')
@Controller('unlock')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UnlockController {
  constructor(private readonly unlockService: UnlockService) {}

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('business')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock verified contact intelligence for a business using credits' })
  @ApiResponse({ status: 200, description: 'Unmasked lead details and updated credit balance' })
  @ApiResponse({ status: 402, description: 'Insufficient credit balance' })
  async unlockBusiness(
    @CurrentUser() user: IJwtPayload,
    @Body() dto: UnlockBusinessDto,
  ) {
    return this.unlockService.unlockBusiness(user.sub, dto.businessId);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get user history of unlocked leads' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of unlocked leads' })
  async getUnlockHistory(
    @CurrentUser() user: IJwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = boundedPage(page, limit);
    return this.unlockService.getUnlockHistory(user.sub, p.page, p.limit);
  }

  @Get('user-leads')
  @ApiOperation({ summary: 'Ids of all businesses the current user has unlocked' })
  @ApiResponse({ status: 200, description: '{ unlockedIds: string[] }' })
  async getUserLeads(@CurrentUser() user: IJwtPayload) {
    return this.unlockService.getUnlockedBusinessIds(user.sub);
  }

  @Get('status/:businessId')
  @ApiOperation({ summary: 'Check if a business has been unlocked by current user' })
  @ApiResponse({ status: 200, description: 'Unlock status' })
  async checkStatus(
    @CurrentUser() user: IJwtPayload,
    @Param('businessId') businessId: string,
  ) {
    return this.unlockService.checkStatus(user.sub, businessId);
  }
}

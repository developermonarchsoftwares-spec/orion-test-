import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CreditService } from './credit.service';
import { CurrentUser, Public, Roles } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { IJwtPayload, UserRole } from '@orion/shared';
import { AdminAdjustCreditsDto } from './dto/admin-adjust-credits.dto';
import { UpdatePricingSettingDto } from './dto/pricing-setting.dto';
import { CreateCreditPackageDto, UpdateCreditPackageDto } from './dto/credit-package.dto';
import { boundedPage } from '../../common/utils/pagination.util';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Credits & Wallet')
@Controller('credit')
export class CreditController {
  constructor(private readonly creditService: CreditService) {}

  @UseGuards(JwtAuthGuard)
  @Get('wallet')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user credit balance and wallet statistics' })
  @ApiResponse({ status: 200, description: 'Wallet balance, daily credits, and lifetime metrics' })
  async getWallet(@CurrentUser() user: IJwtPayload) {
    return this.creditService.getWalletWithStatus(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('transactions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get paginated credit transaction history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Transaction ledger list' })
  async getTransactions(
    @CurrentUser() user: IJwtPayload,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const p = boundedPage(page, limit);
    return this.creditService.getTransactions(user.sub, p.page, p.limit);
  }

  @Public()
  @Get('packages')
  @ApiOperation({ summary: 'Get all active credit packages with dynamic annual pricing' })
  @ApiResponse({ status: 200, description: 'List of credit packages' })
  async getPackages() {
    return this.creditService.getPackages();
  }

  @Public()
  @Get('config')
  @ApiOperation({ summary: 'Get platform pricing and credit configuration' })
  @ApiResponse({ status: 200, description: 'Pricing configuration policies' })
  async getPricingConfig() {
    return this.creditService.getPricingConfig();
  }

  // ================= ADMIN MANAGEMENT ROUTES =================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @Get('admin/packages')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Get all packages (active & inactive)' })
  async adminGetAllPackages() {
    return this.creditService.getAllPackages();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN) // money: prices and packages are changed by a super administrator only
  @Post('admin/packages')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Create new credit package' })
  async adminCreatePackage(@CurrentUser() admin: IJwtPayload, @Body() dto: CreateCreditPackageDto) {
    return this.creditService.createPackage(dto, admin.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Put('admin/packages/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Update credit package' })
  async adminUpdatePackage(@CurrentUser() admin: IJwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCreditPackageDto) {
    return this.creditService.updatePackage(id, dto, admin.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Delete('admin/packages/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Delete credit package' })
  async adminDeletePackage(@CurrentUser() admin: IJwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.creditService.deletePackage(id, admin.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Put('admin/config')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Update pricing settings config' })
  async adminUpdateConfig(@CurrentUser() admin: IJwtPayload, @Body() body: UpdatePricingSettingDto) {
    return this.creditService.updatePricingSetting(body.key, body.value, body.description, admin.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN) // an ordinary administrator can no longer credit any wallet, including their own
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('admin/adjust')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: Adjust user wallet credits' })
  async adminAdjustCredits(
    @CurrentUser() admin: IJwtPayload,
    @Body() body: AdminAdjustCreditsDto,
  ) {
    return this.creditService.adjustUserCredits(
      body.userId,
      body.dailyDelta || 0,
      body.purchasedDelta || 0,
      body.reason || 'Manual Admin Adjustment',
      admin.sub,
    );
  }
}

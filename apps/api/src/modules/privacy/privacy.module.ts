import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ContactSuppressionService } from './contact-suppression.service';
import { PrivacyController } from './privacy.controller';
import { RightsRequestController } from './rights-request.controller';
import { RightsRequestService } from './rights-request.service';
import { PrivacyScheduler } from './privacy.scheduler';
import { PrivacyService } from './privacy.service';

@Module({
  imports: [AuthModule], // PasswordService (confirm a deletion) and MailService (notice)
  controllers: [PrivacyController, RightsRequestController],
  providers: [PrivacyService, PrivacyScheduler, ContactSuppressionService, RightsRequestService],
  exports: [PrivacyService, ContactSuppressionService, RightsRequestService],
})
export class PrivacyModule {}

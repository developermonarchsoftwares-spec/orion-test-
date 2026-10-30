import { Equals, IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RIGHTS_REQUEST_TYPES } from '../privacy.config';

/** A Data Principal's request under the DPDP Act, taken from the public form. The requester need not be an Orion customer. */
export class CreateRightsRequestDto {
  @IsIn([...RIGHTS_REQUEST_TYPES])
  type!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** CUSTOMER (has an Orion account) or OTHER (a person whose business details appear in Orion). */
  @IsIn(['CUSTOMER', 'OTHER'])
  relationship!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;

  /** The requester agrees that the details given here are used to handle the request (and for nothing else). Must be true. */
  @IsBoolean()
  @Equals(true)
  processingConsent!: boolean;

  /** Cloudflare Turnstile token; checked only when the deployment has a Turnstile secret. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  captchaToken?: string;
}

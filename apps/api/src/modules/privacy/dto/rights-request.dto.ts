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

/** A reviewer's decision on one rights request (admin). */
export class DecideRightsRequestDto {
  @IsIn(['REQUEST_INFO', 'COMPLETE', 'REJECT'])
  action!: string;

  /** The only text the requester receives (by e-mail). Required to ask for information or to reject. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  message?: string;

  /** Internal reason; never sent to the requester. Required to reject. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** The reviewer confirms they checked who the requester is. Required to complete anything except a grievance or an erasure. */
  @IsOptional()
  @IsBoolean()
  identityChecked?: boolean;
}

/** The confirmation an erasure requester sends after opening the link in the e-mail. */
export class ConfirmRightsRequestDto {
  @IsString()
  @MaxLength(20)
  reference!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  token!: string;
}

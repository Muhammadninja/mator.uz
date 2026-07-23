import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Request,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserService } from './user.service';
import { AvatarService, MAX_AVATAR_BYTES } from './avatar.service';
import { PhoneChangeService } from './phone-change.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { RequestPhoneChangeDto } from './dto/request-phone-change.dto';
import { ConfirmPhoneChangeDto } from './dto/confirm-phone-change.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdatePreferencesDto } from '../notifications/dto/update-preferences.dto';

const AVATAR_CDN_URL =
  'https://res.cloudinary.com/mator/image/upload/v1/mator/avatars/abc.png';

// Official documented response: `avatarUrl` (matches profile-api-spec §3). The
// endpoint additionally returns `url` and `avatar_url` at runtime as deprecated
// backward-compatibility aliases (not part of the documented contract).
const AVATAR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    avatarUrl: {
      type: 'string',
      description: 'Official field — the stored image URL.',
      example: AVATAR_CDN_URL,
    },
    url: {
      type: 'string',
      deprecated: true,
      description: 'Deprecated alias of avatarUrl (compat).',
      example: AVATAR_CDN_URL,
    },
    avatar_url: {
      type: 'string',
      deprecated: true,
      description: 'Deprecated alias of avatarUrl (compat).',
      example: AVATAR_CDN_URL,
    },
  },
  required: ['avatarUrl'],
};

// Multipart field names accepted for the image, in priority order. `avatar` is
// the official field (real RN client + spec); `file`/`image` are accepted so a
// client written against either wording works without a change.
const AVATAR_FIELD_PRIORITY = ['avatar', 'file', 'image'] as const;

const PHONE_CONFIRM_RESPONSE_EXAMPLE = {
  user: { id: 'a1b2…', phone_e164: '+998901234567', phone_verified: true },
  tokens: {
    access_token: 'eyJ…',
    access_token_expires_at: '2026-07-23T11:00:00.000Z',
    refresh_token: 'rt_…',
    refresh_token_expires_at: '2026-10-21T10:00:00.000Z',
    token_type: 'Bearer',
  },
};

@ApiTags('User')
@ApiBearerAuth('jwt')
@Controller('v1/me')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(
    private readonly users: UserService,
    private readonly avatars: AvatarService,
    private readonly phoneChange: PhoneChangeService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Get the authenticated user's profile (includes default address or null).",
  })
  getMe(@Request() req: { user: { id: string } }) {
    return this.users.getMe(req.user.id);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Partial profile update. An optional inline `address` upserts the default address (single source of truth — reuses the Address table).',
  })
  updateMe(@Request() req: { user: { id: string } }, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.id, dto);
  }

  // ── Avatar upload ─────────────────────────────────────────────────────────
  // Multipart/form-data. AnyFilesInterceptor accepts any field name; the handler
  // then selects the image by AVATAR_FIELD_PRIORITY (`avatar` → `file` →
  // `image`), so the runtime RN client (`avatar`) and any client written against
  // the Swagger/task wording (`file`) or a generic `image` field all work. The
  // official response field is `avatarUrl`; `url`/`avatar_url` are compat aliases.
  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @UseInterceptors(
    AnyFilesInterceptor({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }),
  )
  @ApiOperation({
    summary:
      'Upload a profile avatar (multipart/form-data). Field: `avatar` (aliases `file`, `image`).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
          description:
            'Image file (JPEG/PNG/WebP, ≤ 5 MB). Aliases: `file`, `image`.',
        },
      },
      required: ['avatar'],
    },
  })
  @ApiOkResponse({
    description: 'Uploaded. Returns the stored image URL as `avatarUrl`.',
    schema: AVATAR_RESPONSE_SCHEMA,
  })
  uploadAvatar(
    @Request() req: { user: { id: string } },
    @UploadedFiles()
    files?: Array<{
      fieldname: string;
      buffer: Buffer;
      mimetype: string;
      size: number;
    }>,
  ) {
    // Select the image by field-name priority; fall back to the first file for
    // any other single-field name a client might use.
    const file =
      AVATAR_FIELD_PRIORITY.map((name) =>
        files?.find((f) => f.fieldname === name),
      ).find(Boolean) ?? files?.[0];
    return this.avatars.upload(req.user.id, file);
  }

  // ── Phone change ────────────────────────────────────────────────────────────
  @Post('phone/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
  @ApiOperation({
    summary: 'Request an OTP to change the account phone number.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        phone: '+998901234567',
        expires_at: '2026-07-23T10:05:00.000Z',
        resend_after_seconds: 60,
        otp_length: 6,
        delivery_channel: 'sms',
      },
    },
  })
  @ApiConflictResponse({
    description: 'The phone number is already used by another account.',
    schema: {
      example: {
        code: 'CONFLICT',
        message: 'This phone number is already in use by another account.',
      },
    },
  })
  requestPhoneChange(
    @Request() req: { user: { id: string } },
    @Body() dto: RequestPhoneChangeDto,
  ) {
    return this.phoneChange.request(req.user.id, dto.phone);
  }

  @Post('phone/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @ApiOperation({
    summary:
      'Confirm the OTP and move the account to the new phone number. Old sessions are revoked and a FRESH token pair is returned (seamless, no re-login).',
  })
  @ApiOkResponse({
    description:
      'Phone changed. Returns the updated profile and a new access/refresh token pair; all previous refresh tokens are revoked.',
    schema: { example: PHONE_CONFIRM_RESPONSE_EXAMPLE },
  })
  confirmPhoneChange(
    @Request() req: { user: { id: string } },
    @Body() dto: ConfirmPhoneChangeDto,
  ) {
    return this.phoneChange.confirm(req.user.id, dto.phone, dto.otp);
  }

  // Notification preferences live in the Notifications domain; expose them here
  // under /v1/me for the frontend contract without duplicating storage.
  @Get('preferences')
  @HttpCode(HttpStatus.OK)
  getPreferences(@Request() req: { user: { id: string } }) {
    return this.notifications.getPreferences(req.user.id);
  }

  @Patch('preferences')
  @HttpCode(HttpStatus.OK)
  updatePreferences(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.notifications.updatePreferences(req.user.id, dto);
  }
}

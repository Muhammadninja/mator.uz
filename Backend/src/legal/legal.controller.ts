import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import { LegalDocumentType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { resolveRequestLang } from '../common/app-lang.util';
import { LegalService } from './legal.service';
import { AcceptLegalDocumentsDto } from './dto/accept-legal-documents.dto';
import { LegalDocumentVersionParamsDto } from './dto/legal-document-version.params.dto';

const DOCUMENT_EXAMPLE = {
  type: LegalDocumentType.TERMS_OF_USE,
  version: 1,
  locale: 'ru',
  title: 'Пользовательское соглашение',
  content: '# Пользовательское соглашение\n\n…',
  content_format: 'markdown',
  effective_at: '2026-08-31T00:00:00.000Z',
  is_required: true,
};

const STATUS_EXAMPLE = {
  requires_acceptance: true,
  documents: [
    {
      type: LegalDocumentType.TERMS_OF_USE,
      required_version: 1,
      accepted_version: 1,
      accepted: true,
      accepted_at: '2026-08-31T12:33:10.000Z',
    },
    {
      type: LegalDocumentType.PRIVACY_POLICY,
      required_version: 2,
      accepted_version: 1,
      accepted: false,
      accepted_at: '2026-08-31T12:33:10.000Z',
    },
    {
      type: LegalDocumentType.PERSONAL_DATA_CONSENT,
      required_version: 1,
      accepted_version: null,
      accepted: false,
    },
  ],
};

const ACCEPT_LANGUAGE_HEADER = {
  name: 'Accept-Language',
  required: false,
  description:
    'Document language: ru | uz | en (regional tags like ru-RU accepted). ' +
    'Falls back to ru, then to any published translation — a missing ' +
    'translation never yields an empty response.',
};

/**
 * Legal documents and consent records.
 *
 * Reading the documents is PUBLIC (they must be displayable before an account
 * exists — that is when the first consent is given). Everything that touches a
 * person's consent record requires a JWT, and always acts on the caller's own
 * id: there is no route on which a userId can be supplied.
 */
@ApiTags('Legal')
@Controller('v1/legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Get('documents')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The legal documents currently in force, for display and acceptance.',
    description:
      'Public — the documents must be readable before an account exists. ' +
      'Returns every required document at its active version.',
  })
  @ApiHeader(ACCEPT_LANGUAGE_HEADER)
  @ApiOkResponse({ schema: { example: { documents: [DOCUMENT_EXAMPLE] } } })
  async listDocuments(@Headers('accept-language') acceptLanguage?: string) {
    const documents = await this.legal.listCurrentDocuments(
      resolveRequestLang(acceptLanguage),
    );
    return { documents };
  }

  // Declared BEFORE nothing conflicting, but kept after `documents` for
  // readability; Nest matches the static 'documents' path first regardless.
  @Get('documents/:type/:version')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One specific document version, including superseded ones.',
    description:
      'Public. Serves the historical text a user actually consented to, so an ' +
      'acceptance record can be shown alongside the wording it refers to.',
  })
  @ApiParam({ name: 'type', enum: LegalDocumentType })
  @ApiParam({ name: 'version', type: Number, example: 1 })
  @ApiHeader(ACCEPT_LANGUAGE_HEADER)
  @ApiOkResponse({ schema: { example: DOCUMENT_EXAMPLE } })
  getDocumentVersion(
    @Param() params: LegalDocumentVersionParamsDto,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.legal.getDocumentVersion(
      params.type,
      params.version,
      resolveRequestLang(acceptLanguage),
    );
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Which documents the caller still has to accept.",
    description:
      'requires_acceptance is true when any required document has not been ' +
      'accepted at its current version — including a user who accepted v1 of a ' +
      'document that has since been re-issued as v2.',
  })
  @ApiHeader(ACCEPT_LANGUAGE_HEADER)
  @ApiOkResponse({ schema: { example: STATUS_EXAMPLE } })
  getStatus(
    @Request() req: { user: { id: string } },
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.legal.getStatus(req.user.id, resolveRequestLang(acceptLanguage));
  }

  @Post('accept')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the caller’s consent to the current document versions.',
    description:
      'The submitted `version` is verified against the version actually in ' +
      'force; a stale or unknown version is rejected. All required documents ' +
      'must be present, and all rows are written in one transaction. Returns ' +
      'the resulting status, so the client needs no follow-up call.',
  })
  @ApiHeader(ACCEPT_LANGUAGE_HEADER)
  @ApiOkResponse({
    schema: { example: { ...STATUS_EXAMPLE, requires_acceptance: false } },
  })
  @ApiBadRequestResponse({
    description:
      'A required document is missing, repeated, or submitted at a version ' +
      'that is not the one in force.',
    schema: {
      example: {
        code: 'LEGAL_ACCEPTANCE_REQUIRED',
        message: 'Required legal documents must be accepted: PRIVACY_POLICY.',
      },
    },
  })
  accept(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Body() dto: AcceptLegalDocumentsDto,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    // Provenance is read from the request, never from the body: an acceptance is
    // evidence, and evidence a client can dictate is worthless. `req.ip` is the
    // real client address because main.ts sets `trust proxy` for the Nginx hop.
    return this.legal.accept(req.user.id, dto.acceptances, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      locale: resolveRequestLang(acceptLanguage),
    });
  }
}

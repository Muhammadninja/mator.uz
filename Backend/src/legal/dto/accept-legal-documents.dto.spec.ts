// DTO-level validation for POST /v1/legal/accept. These run the SAME pipeline
// the app uses (whitelist + forbidNonWhitelisted + transform), so a rule that
// passes here is the rule the endpoint actually enforces.

import { ValidationPipe } from '@nestjs/common';
import { LegalDocumentType } from '@prisma/client';
import { AcceptLegalDocumentsDto } from './accept-legal-documents.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta = {
  type: 'body' as const,
  metatype: AcceptLegalDocumentsDto,
  data: '',
};

const valid = {
  acceptances: [
    { type: LegalDocumentType.TERMS_OF_USE, version: 1 },
    { type: LegalDocumentType.PRIVACY_POLICY, version: 1 },
    { type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 },
  ],
};

describe('AcceptLegalDocumentsDto', () => {
  it('accepts a well-formed body', async () => {
    await expect(pipe.transform(valid, meta)).resolves.toMatchObject(valid);
  });

  it('rejects an empty acceptances array', async () => {
    await expect(pipe.transform({ acceptances: [] }, meta)).rejects.toThrow();
  });

  it('rejects a missing acceptances array', async () => {
    await expect(pipe.transform({}, meta)).rejects.toThrow();
  });

  it('rejects an unknown document type', async () => {
    await expect(
      pipe.transform(
        { acceptances: [{ type: 'COOKIE_BANNER', version: 1 }] },
        meta,
      ),
    ).rejects.toThrow();
  });

  it('rejects version 0 and negative versions', async () => {
    for (const version of [0, -1]) {
      await expect(
        pipe.transform(
          { acceptances: [{ type: LegalDocumentType.TERMS_OF_USE, version }] },
          meta,
        ),
      ).rejects.toThrow();
    }
  });

  it('rejects a non-integer version', async () => {
    await expect(
      pipe.transform(
        { acceptances: [{ type: LegalDocumentType.TERMS_OF_USE, version: 1.5 }] },
        meta,
      ),
    ).rejects.toThrow();
  });

  it('rejects the SAME document type twice — the request is self-contradictory', async () => {
    await expect(
      pipe.transform(
        {
          acceptances: [
            { type: LegalDocumentType.PRIVACY_POLICY, version: 1 },
            { type: LegalDocumentType.PRIVACY_POLICY, version: 2 },
          ],
        },
        meta,
      ),
    ).rejects.toThrow();
  });

  it('rejects an oversized array before validating it element by element', async () => {
    const huge = Array.from({ length: 5000 }, () => ({
      type: LegalDocumentType.TERMS_OF_USE,
      version: 1,
    }));
    await expect(pipe.transform({ acceptances: huge }, meta)).rejects.toThrow();
  });

  it('strips/rejects an unexpected field (no userId smuggling)', async () => {
    // forbidNonWhitelisted: a body trying to name a victim user is rejected
    // outright rather than silently ignored.
    await expect(
      pipe.transform({ ...valid, userId: 'someone-else' }, meta),
    ).rejects.toThrow();
  });
});

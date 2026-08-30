import { LegalDocument, LegalDocumentType } from '@prisma/client';

/**
 * Wire shapes for /v1/legal/*, in the buyer API's snake_case convention (as used
 * by /v1/auth, /v1/addresses and /v1/mobile-config).
 *
 * These types ARE the contract. Prisma rows are never returned directly: `id`,
 * `isActive`, `createdAt` and `updatedAt` are internal bookkeeping the client has
 * no use for, and leaking them would freeze storage decisions into the API.
 */

/** A document as served for display and acceptance. */
export interface LegalDocumentResponse {
  type: LegalDocumentType;
  version: number;
  locale: string;
  title: string;
  content: string;
  content_format: string;
  effective_at: string;
  /**
   * Whether consent to this document is mandatory. Every document Mator
   * currently ships is required; the field exists so an optional document (a
   * marketing consent, say) can be added later without a contract change.
   */
  is_required: boolean;
}

/** One document's acceptance state for the calling user. */
export interface LegalStatusItemResponse {
  type: LegalDocumentType;
  required_version: number;
  accepted_version: number | null;
  accepted: boolean;
  /** Timestamp of the user's LATEST acceptance of this document, any version. */
  accepted_at?: string;
}

export interface LegalStatusResponse {
  requires_acceptance: boolean;
  documents: LegalStatusItemResponse[];
}

/** Map a document row to the public contract. */
export function presentLegalDocument(
  doc: LegalDocument,
  isRequired = true,
): LegalDocumentResponse {
  return {
    type: doc.type,
    version: doc.version,
    locale: doc.locale,
    title: doc.title,
    content: doc.content,
    content_format: doc.contentFormat,
    effective_at: doc.effectiveAt.toISOString(),
    is_required: isRequired,
  };
}

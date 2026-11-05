import { PaymeFiscalReceiptType, Prisma } from '@prisma/client';

/**
 * Reading a SetFiscalData call. Pure, so what counts as malformed is testable on its own.
 *
 * Payme's page gives the fields but marks none of them required, and its own table and
 * samples disagree on `receipt_id` (String in one, a number in the other). What is
 * refused is therefore what could not be stored faithfully, or what says nothing at all.
 * A missing field is not refused: a registration that failed may have no fiscal sign,
 * and turning it away would lose the one record that it failed.
 */

/** The one status code Payme's documentation shows a meaning for ("accepted"). */
export const FISCAL_STATUS_ACCEPTED = 0;

/** One SetFiscalData call, reduced to what is stored. */
export interface FiscalReceiptCallback {
  /** Payme's id of the check: `params.id` of CreateTransaction. */
  transactionId: string;
  type: PaymeFiscalReceiptType;
  receiptId: string | null;
  statusCode: number | null;
  message: string | null;
  terminalId: string | null;
  fiscalSign: string | null;
  qrCodeUrl: string | null;
  fiscalDate: string | null;
  /** `fiscal_data` as it arrived, so a field added later is not lost. */
  raw: Prisma.InputJsonObject;
}

export type ParsedSetFiscalData =
  | { ok: true; callback: FiscalReceiptCallback }
  /** `invalid` names the parameter: -32602 carries it in `message`. */
  | { ok: false; invalid: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Thrown only inside this module, to name a field from any depth. */
class InvalidField extends Error {}

/** A text field: absent or blank is null. Anything else but text is refused. */
function text(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  throw new InvalidField(`fiscal_data.${field}`);
}

/**
 * An identifier: text, or a number standing for one, as `receipt_id` is in Payme's own
 * sample. A number past the safe range has already lost digits in JSON.parse, so it
 * cannot be stored faithfully and is refused.
 */
function identifier(
  data: Record<string, unknown>,
  field: string,
): string | null {
  const value = data[field];
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return String(value);
    throw new InvalidField(`fiscal_data.${field}`);
  }
  return text(data, field);
}

/** Validate the whole of `params`, or name the first thing wrong with it. */
export function parseSetFiscalData(params: unknown): ParsedSetFiscalData {
  if (!isObject(params)) return { ok: false, invalid: 'params' };
  const { id, type, fiscal_data: data } = params;

  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, invalid: 'id' };
  }
  if (
    type !== PaymeFiscalReceiptType.PERFORM &&
    type !== PaymeFiscalReceiptType.CANCEL
  ) {
    return { ok: false, invalid: 'type' };
  }
  if (!isObject(data)) return { ok: false, invalid: 'fiscal_data' };

  const statusCode = data.status_code ?? null;
  if (statusCode !== null && !Number.isSafeInteger(statusCode)) {
    return { ok: false, invalid: 'fiscal_data.status_code' };
  }

  try {
    const receiptId = identifier(data, 'receipt_id');
    // Neither what the receipt is nor how it went: nothing here to keep.
    if (receiptId === null && statusCode === null) {
      return { ok: false, invalid: 'fiscal_data' };
    }
    return {
      ok: true,
      callback: {
        transactionId: id,
        type,
        receiptId,
        statusCode: statusCode as number | null,
        message: text(data, 'message'),
        terminalId: identifier(data, 'terminal_id'),
        fiscalSign: identifier(data, 'fiscal_sign'),
        qrCodeUrl: text(data, 'qr_code_url'),
        fiscalDate: identifier(data, 'date'),
        raw: data as Prisma.InputJsonObject,
      },
    };
  } catch (err) {
    if (err instanceof InvalidField) return { ok: false, invalid: err.message };
    throw err;
  }
}

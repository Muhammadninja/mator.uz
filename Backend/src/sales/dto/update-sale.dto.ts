import { PartialType } from '@nestjs/swagger';
import { CreateSaleDto } from './create-sale.dto';

/**
 * PATCH body: every create field, all optional. `PartialType` from
 * @nestjs/swagger (not @nestjs/mapped-types) so the generated OpenAPI schema
 * keeps the property docs while relaxing them to optional.
 *
 * With the global ValidationPipe's `forbidNonWhitelisted`, a body naming a
 * field that is not declared on CreateSaleDto is rejected with 400 rather than
 * silently ignored — the DTO is the whitelist.
 *
 * The cross-field rules inherited from CreateSaleDto (percent <= 100, endAt >=
 * startAt) only fire when the body carries both halves of the pair. A partial
 * body that changes one half is re-checked in the service against the stored
 * row, so neither rule can be bypassed by splitting it across two requests.
 */
export class UpdateSaleDto extends PartialType(CreateSaleDto) {}

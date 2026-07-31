import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ReferenceService } from './reference.service';

/**
 * Buyer Reference API — read-only lookups for the vehicle picker chain
 * (make → model → trim → engine). Public (no auth): these are static reference
 * lists the client uses to populate dropdowns and to build fitment ids that the
 * Garage endpoints validate against.
 */
@ApiTags('reference')
@Controller('v1/reference')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get('makes')
  @ApiOperation({ summary: 'List all vehicle makes (frontend catalog order).' })
  @ApiOkResponse({
    description: 'Makes ordered by sortOrder.',
    schema: {
      example: {
        items: [{ id: 'chevrolet', name: 'Chevrolet', logo_url: null }],
        total: 10,
      },
    },
  })
  makes() {
    return this.reference.listMakes();
  }

  @Get('models')
  @ApiOperation({ summary: 'List models for a make (frontend catalog order).' })
  @ApiQuery({ name: 'makeId', required: true, example: 'chevrolet' })
  @ApiOkResponse({
    description: 'Models for the make.',
    schema: {
      example: {
        items: [{ id: 'cobalt', make_id: 'chevrolet', name: 'Cobalt' }],
        total: 10,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'makeId is missing or blank.',
    schema: { example: { code: 'BAD_REQUEST', message: 'makeId is required' } },
  })
  @ApiNotFoundResponse({
    description: 'makeId is unknown.',
    schema: { example: { code: 'NOT_FOUND', message: 'Unknown make_id' } },
  })
  models(@Query('makeId') makeId: string) {
    return this.reference.listModels(makeId);
  }

  @Get('trims')
  @ApiOperation({ summary: 'List trims for a model (frontend catalog order).' })
  @ApiQuery({ name: 'modelId', required: true, example: 'cobalt' })
  @ApiOkResponse({
    description: 'Trims for the model.',
    schema: {
      example: {
        items: [
          { id: 'cobalt-p2-premier', model_id: 'cobalt', name: 'Premier' },
        ],
        total: 7,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'modelId is missing or blank.',
    schema: {
      example: { code: 'BAD_REQUEST', message: 'modelId is required' },
    },
  })
  @ApiNotFoundResponse({
    description: 'modelId is unknown.',
    schema: { example: { code: 'NOT_FOUND', message: 'Unknown model_id' } },
  })
  trims(@Query('modelId') modelId: string) {
    return this.reference.listTrims(modelId);
  }

  @Get('engines')
  @ApiOperation({
    summary: 'List engines (frontend catalog order).',
    description:
      'trimId currently performs existence validation only. Engine filtering is ' +
      'not available because the backend schema intentionally does not store ' +
      'trim-to-engine relationships (see Architecture: Year-based fitment / Do NOT ' +
      'change). When trimId is supplied it is validated (404 if unknown) and the ' +
      'full engine list is returned.',
  })
  @ApiQuery({ name: 'trimId', required: false, example: 'cobalt-p2-premier' })
  @ApiOkResponse({
    description:
      'All engines. If trimId is supplied it is validated for existence only (404 if unknown) and does NOT filter the list.',
    schema: {
      example: {
        items: [
          {
            id: 'b15d2-turbo',
            name: '1.5L Turbo (B15D2)',
            displacement_cc: 1500,
            fuel_type: 'petrol',
          },
        ],
        total: 9,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'trimId is supplied but unknown (existence validation only).',
    schema: { example: { code: 'NOT_FOUND', message: 'Unknown trim_id' } },
  })
  engines(@Query('trimId') trimId?: string) {
    return this.reference.listEngines(trimId);
  }

  /**
   * The dynamic part-category tree, one level at a time — the endpoint the
   * Telegram seller bot walks. Omit `parentId` for the root (vehicle) categories;
   * pass one to get that category's children.
   *
   * ONLY active categories are ever returned, at any level: a category the admin
   * deactivates disappears from the bot on the next read. An empty `items` is a
   * normal answer and is exactly what tells the bot to skip the selection step.
   */
  @Get('categories')
  @ApiOperation({
    summary:
      'List active part categories (roots, or the children of parentId).',
    description:
      'Without parentId: the active root (vehicle) categories. With parentId: ' +
      "that category's active children. Inactive categories are never returned. " +
      'An empty items array means the category is a leaf — the caller should not ' +
      'render a further selection step.',
  })
  @ApiQuery({ name: 'parentId', required: false, example: 'brake-system' })
  @ApiOkResponse({
    description: 'Active categories in display order.',
    schema: {
      example: {
        items: [
          {
            id: 'brake-pads',
            name: 'Brake Pads',
            slug: 'brake-pads',
            parentId: 'brakes',
            level: 2,
            sortOrder: 1,
          },
        ],
        total: 1,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'parentId is supplied but unknown.',
    schema: { example: { code: 'NOT_FOUND', message: 'Category not found' } },
  })
  categories(@Query('parentId') parentId?: string) {
    return this.reference.listCategories(parentId);
  }

  @Get('categories/:id/children')
  @ApiOperation({
    summary: 'List the active children of one category.',
    description:
      'Path-param form of GET /v1/reference/categories?parentId=<id>, returning ' +
      'the identical payload. 404 when the category itself is unknown.',
  })
  @ApiOkResponse({ description: 'Active children in display order.' })
  @ApiNotFoundResponse({ description: 'No such category.' })
  categoryChildren(@Param('id') id: string) {
    return this.reference.listCategories(id);
  }
}

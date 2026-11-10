import { BadRequestException, PipeTransform } from '@nestjs/common';

/**
 * A single query parameter read with `@Query('name')` (LOW-CAT-009).
 *
 * Express turns `?q=a&q=b` into an array and `?q[x]=1` into an object, and a
 * handler typed `string` would pass either into a query and fail as a 500.
 * These pipes make the type real: one string, of bounded length, or a 400.
 */
export class ScalarQueryPipe implements PipeTransform {
  constructor(
    private readonly name: string,
    private readonly maxLength = 200,
    private readonly required = false,
  ) {}

  transform(value: unknown): string | undefined {
    if (value === undefined || value === '') {
      if (this.required) {
        throw new BadRequestException(`${this.name} is required`);
      }
      return value === '' ? '' : undefined;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${this.name} must be a single value`);
    }
    if (value.length > this.maxLength) {
      throw new BadRequestException(
        `${this.name} must be at most ${this.maxLength} characters`,
      );
    }
    return value;
  }
}

/** A bounded integer query parameter; absent means `fallback`. */
export class BoundedIntQueryPipe implements PipeTransform {
  constructor(
    private readonly name: string,
    private readonly min: number,
    private readonly max: number,
    private readonly fallback: number,
  ) {}

  transform(value: unknown): number {
    if (value === undefined || value === '') return this.fallback;
    if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) {
      throw new BadRequestException(`${this.name} must be an integer`);
    }
    const n = Number(value);
    if (n < this.min || n > this.max) {
      throw new BadRequestException(
        `${this.name} must be between ${this.min} and ${this.max}`,
      );
    }
    return n;
  }
}

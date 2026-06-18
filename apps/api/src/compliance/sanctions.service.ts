import { Injectable, Logger } from '@nestjs/common';

/**
 * DTTOT (Daftar Terduga Teroris dan Organisasi Teroris) screening.
 * Real implementation pulls the latest list from PPATK / Kemenkumham,
 * computes a fuzzy match against name + DOB, and blocks/flags hits.
 *
 * For now this is a stub that always passes — but the call site exists,
 * so wiring in the real list later is a one-file change.
 */
@Injectable()
export class SanctionsService {
  private readonly log = new Logger(SanctionsService.name);

  async screen(input: { fullName: string; dob?: Date }) {
    this.log.debug(`Sanctions screen (stub) for ${input.fullName}`);
    return { hit: false, list: 'DTTOT' as const, score: 0 };
  }
}

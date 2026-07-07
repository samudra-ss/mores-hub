import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { extname, join } from 'path';

/**
 * Receipt/invoice storage behind one seam.
 *
 * Local-disk implementation for dev. Production swaps the two methods for an
 * S3-compatible client with server-side encryption (see FRAMEWORK-REVIEW.md
 * checklist) — callers only ever hold an opaque `key`.
 */
@Injectable()
export class StorageService {
  private readonly dir = process.env.RECEIPTS_DIR ?? join(process.cwd(), 'uploads');
  private static readonly ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.svg']);
  private static readonly MAX_BYTES = 6 * 1024 * 1024;

  async save(file: Express.Multer.File): Promise<string> {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('Receipt/invoice file is required');
    }
    if (file.size > StorageService.MAX_BYTES) {
      throw new BadRequestException('File exceeds 6 MB limit');
    }
    const ext = extname(file.originalname || '').toLowerCase();
    if (!StorageService.ALLOWED.has(ext)) {
      throw new BadRequestException(`File type ${ext || '(none)'} not allowed`);
    }
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const key = randomUUID().replace(/-/g, '') + ext;
    await writeFile(join(this.dir, key), file.buffer);
    return key;
  }

  /** Absolute path for res.sendFile. Refuses path traversal. */
  pathFor(key: string): string {
    if (key.includes('/') || key.includes('\\') || key.includes('..')) {
      throw new BadRequestException('Bad key');
    }
    return join(this.dir, key);
  }
}

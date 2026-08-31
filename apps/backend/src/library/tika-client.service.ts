import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { load } from 'cheerio';

import type { Environment } from '../config/environment';
import type { DocumentPage } from './text-splitter';

@Injectable()
export class TikaClientService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<Environment, true>) {}

  async extract(content: Buffer, contentType: string): Promise<DocumentPage[]> {
    const baseUrl = this.config.get('TIKA_URL', { infer: true }).replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/tika`, {
      method: 'PUT',
      headers: { Accept: 'application/xhtml+xml', 'Content-Type': contentType || 'application/octet-stream' },
      body: content,
      signal: AbortSignal.timeout(this.config.get('TIKA_TIMEOUT_MS', { infer: true })),
    });
    if (!response.ok) throw new Error(`Tika returned HTTP ${response.status}`);
    const document = load(await response.text());
    const pages = document('div.page')
      .toArray()
      .map((element, index) => ({ page: index + 1, text: document(element).text() }));
    if (pages.length) return pages;
    return [{ page: null, text: document('body').text() }];
  }
}

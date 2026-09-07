import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';

import { ArtifactRepository } from './artifact.repository';

export interface ArtifactRenderInput {
  answerId: string;
  title: string;
}

export interface RenderedArtifact {
  filename: string;
  contentType: 'text/markdown';
  body: Readable;
}

@Injectable()
export class MarkdownReportRenderer {
  constructor(@Inject(ArtifactRepository) private readonly repository: ArtifactRepository) {}

  async render(input: ArtifactRenderInput, signal: AbortSignal): Promise<RenderedArtifact> {
    throwIfAborted(signal);
    const events = await this.repository.answerEvents(input.answerId);
    throwIfAborted(signal);
    const text = reconstructAnswerText(events);
    const title = sanitizeTitle(input.title);
    const body = `# ${title}\n\n${text}\n`;
    return {
      filename: `${filenameFromTitle(title)}.md`,
      contentType: 'text/markdown',
      body: Readable.from(Buffer.from(body, 'utf8')),
    };
  }
}

function reconstructAnswerText(events: Array<{ type: string; contentJson: Record<string, unknown> }>): string {
  const chunks = events
    .filter((event) => event.type === 'data' && typeof event.contentJson.text === 'string')
    .map((event) => event.contentJson.text as string);
  if (chunks.length) return chunks.join('');
  const result = events.filter((event) => event.type === 'result' && typeof event.contentJson.text === 'string').at(-1);
  return typeof result?.contentJson.text === 'string' ? result.contentJson.text : '';
}

function sanitizeTitle(value: string): string {
  const sanitized = value
    .replace(/[\\/\r\n\0]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '')
    .trim()
    .slice(0, 120);
  return sanitized || 'Artifact';
}

function filenameFromTitle(title: string): string {
  return title.replace(/\s+/g, '-');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException('Artifact rendering aborted', 'AbortError');
}

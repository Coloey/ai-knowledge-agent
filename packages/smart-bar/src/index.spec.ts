import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { artifactContentPath, artifactFilename } from './index';

const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');

describe('SmartBar presentation boundary', () => {
  it('does not own SSE parsing, AgentEvent decoding, or AbortControllers', () => {
    expect(source).not.toMatch(
      /TextDecoder|ReadableStream|fetchEventSource|decodeAgentEvent|AbortController/,
    );
    expect(source).not.toMatch(/event\.type|switch\s*\(/);
  });

  it.each([
    ['thinking chunks', 'chunk-thinking'],
    ['message chunks', 'chunk-message'],
    ['generic tool calls', "knownLabel || 'Tool call'"],
    ['citations', '<CitationList'],
    ['system errors', '<SystemNoticeView'],
  ])('keeps a renderer for %s', (_label, marker) => {
    expect(source).toContain(marker);
  });

  it('keeps artifact cards answer-scoped and preserves all server refs', () => {
    expect(source).toContain('useAnswerArtifacts(props.part.id)');
    expect(source).toContain('<ArtifactList artifacts={artifacts} />');
    expect(source).toContain('key={artifact.id}');
    expect(source).not.toContain('useThreadArtifacts');
  });

  it.each(['queued', 'processing', 'completed', 'failed'])(
    'renders an accessible artifact state for %s',
    (status) => {
      expect(source).toContain(`${status}:`);
    },
  );

  it('keeps loading, query errors, retry, and the report composer control visible', () => {
    expect(source).toContain('Loading artifact status...');
    expect(source).toContain('Artifact status could not be loaded.');
    expect(source).toContain('useRetryArtifact');
    expect(source).toContain('生成报告');
    expect(source).toContain("outputArtifact: 'document'");
  });

  it('lazily previews escaped Markdown and revokes authenticated downloads', () => {
    expect(source).toContain("'inline'");
    expect(source).toContain('<pre className="artifact-preview-content">');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).toContain("'attachment'");
    expect(source).toContain('URL.createObjectURL');
    expect(source).toContain('URL.revokeObjectURL(url)');
  });
});

describe('artifact content helpers', () => {
  it('encodes artifact IDs and uses explicit content dispositions', () => {
    expect(artifactContentPath('artifact/report 1', 'inline')).toBe(
      '/artifacts/artifact%2Freport%201/content?disposition=inline',
    );
    expect(artifactContentPath('artifact_1', 'attachment')).toBe(
      '/artifacts/artifact_1/content?disposition=attachment',
    );
  });

  it('derives a safe Markdown filename from the artifact title', () => {
    expect(artifactFilename('Quarterly: <Report>?')).toBe(
      'Quarterly-Report.md',
    );
    expect(artifactFilename('')).toBe('report.md');
  });
});

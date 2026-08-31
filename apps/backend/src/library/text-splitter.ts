export interface DocumentPage {
  page: number | null;
  text: string;
}

export interface DocumentChunkInput {
  content: string;
  page: number | null;
  startOffset: number;
  endOffset: number;
}

export function splitText(pages: DocumentPage[], chunkSize = 1_200, overlap = 160): DocumentChunkInput[] {
  if (chunkSize <= 0 || overlap < 0 || overlap >= chunkSize) throw new Error('Invalid chunk configuration');
  const chunks: DocumentChunkInput[] = [];
  for (const page of pages) {
    const text = page.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push({ content: text.slice(start, end), page: page.page, startOffset: start, endOffset: end });
      if (end === text.length) break;
      start = end - overlap;
    }
  }
  return chunks;
}

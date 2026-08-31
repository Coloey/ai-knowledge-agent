export interface SessionEvent {
  type: string;
  session_id: string;
  content: Record<string, unknown>;
}

export function sseData(payload: SessionEvent, sequence?: number): string {
  const id = sequence === undefined ? '' : `id: ${sequence}\n`;
  return `${id}data: ${JSON.stringify(payload)}\n\n`;
}

export function sseDone(): string {
  return 'event: done\ndata: {"done":true}\n\n';
}

export function sseCorsHeaders(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

export function timestampMs(value: Date | null | undefined): number {
  return value ? value.getTime() : 0;
}

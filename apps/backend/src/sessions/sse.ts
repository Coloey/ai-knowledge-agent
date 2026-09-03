import { decodeAgentEvent, type AgentEvent } from '@agent/protocol';

export function sseData(payload: AgentEvent): string {
  const event = decodeAgentEvent(JSON.stringify(payload));
  return `id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`;
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

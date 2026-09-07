import type { ArtifactKind, ArtifactStatus } from '@agent/protocol';
export type { ArtifactDetail } from '@agent/protocol';

export interface ArtifactRequestInput {
  workspaceId: string;
  sessionId: string;
  answerId: string;
  kind: 'document';
  title: string;
}

export interface ArtifactCancellationInput {
  artifactId: string;
  jobId: string;
  version: number;
  deleteArtifact: boolean;
}

export interface StoredArtifactContent {
  status: ArtifactStatus;
  storageKey: string | null;
  mimeType: string | null;
  size: number | null;
}

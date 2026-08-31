import { apiBlobRequest, apiRequest } from './client';
import type { ArtifactPage } from './types';

export function listTaskArtifacts(taskId: string, page = 1, pageSize = 20): Promise<ArtifactPage> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiRequest<ArtifactPage>(`/tasks/${taskId}/artifacts?${query.toString()}`);
}

export function downloadArtifact(artifactId: string) {
  return apiBlobRequest(`/artifacts/${artifactId}/download`);
}

export function downloadTaskArchive(taskId: string) {
  return apiBlobRequest(`/tasks/${taskId}/artifacts/archive`);
}

export function deleteArtifact(artifactId: string): Promise<void> {
  return apiRequest<void>(`/artifacts/${artifactId}`, { method: 'DELETE' });
}

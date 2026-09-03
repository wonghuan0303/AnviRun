import { apiRequest } from './client';
import type { OverviewResponse } from './types';

export function getOverview(): Promise<OverviewResponse> {
  return apiRequest<OverviewResponse>('/overview');
}

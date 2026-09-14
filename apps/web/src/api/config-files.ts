import type { FileConfigValue } from '@anvilrun/contracts';
import { apiRequest } from './client';

export function uploadConfigFile(
  buildTemplateId: string,
  fieldName: string,
  file: File,
): Promise<{ file: FileConfigValue }> {
  const query = new URLSearchParams({ buildTemplateId, fieldName, fileName: file.name });
  return apiRequest(`/config-files?${query.toString()}`, {
    method: 'POST',
    // 始终按二进制流发送，避免 JSON/XML 等文件被服务端通用 body parser 提前消费。
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
}

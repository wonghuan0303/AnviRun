import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from './client';
import { uploadConfigFile } from './config-files';

vi.mock('./client', () => ({ apiRequest: vi.fn() }));

describe('config files API', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    vi.mocked(apiRequest).mockResolvedValue({} as never);
  });

  it('uploads the original File as an octet stream and encodes its context', async () => {
    const file = new File(['{}'], 'app config.json', { type: 'application/json' });

    await uploadConfigFile('template-id', 'packageFile', file);

    expect(apiRequest).toHaveBeenCalledWith(
      '/config-files?buildTemplateId=template-id&fieldName=packageFile&fileName=app+config.json',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      },
    );
  });
});

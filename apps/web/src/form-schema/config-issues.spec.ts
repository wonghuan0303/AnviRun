import { describe, expect, it } from 'vitest';
import type { FormConfigIssue } from '@buildplatform/contracts';

import { removeIssuesForField } from './config-issues';

function issue(
  message: string,
  path: readonly (string | number)[],
  fieldName?: string,
): FormConfigIssue {
  return {
    code: 'FIELD_REQUIRED',
    message,
    path,
    pointer: path.length === 0 ? '' : `/${path.join('/')}`,
    ...(fieldName === undefined ? {} : { fieldName }),
  };
}

describe('removeIssuesForField', () => {
  it('removes only the changed field and retains other and top-level issues', () => {
    const fieldA = issue('A issue', ['fieldA'], 'fieldA');
    const fieldAByPath = issue('A path issue', ['fieldA', 0], 'legacy-name');
    const fieldB = issue('B issue', ['fieldB'], 'fieldB');
    const topLevel = issue('Top-level issue', []);

    expect(removeIssuesForField([fieldA, fieldAByPath, fieldB, topLevel], 'fieldA')).toEqual([
      fieldB,
      topLevel,
    ]);
  });
});

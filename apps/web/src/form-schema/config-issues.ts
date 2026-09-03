import type { FormConfigIssue } from '@anvilrun/contracts';

export function removeIssuesForField(
  issues: readonly FormConfigIssue[],
  fieldName: string,
): FormConfigIssue[] {
  return issues.filter((issue) => issue.fieldName !== fieldName && issue.path[0] !== fieldName);
}

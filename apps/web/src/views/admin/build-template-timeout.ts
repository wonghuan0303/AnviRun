export const BUILD_TIMEOUT_MIN_SECONDS = 1;
export const BUILD_TIMEOUT_MAX_SECONDS = 86_400;
export const BUILD_TIMEOUT_STEP_SECONDS = 60;

export function isValidBuildTimeoutSeconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= BUILD_TIMEOUT_MIN_SECONDS &&
    value <= BUILD_TIMEOUT_MAX_SECONDS
  );
}

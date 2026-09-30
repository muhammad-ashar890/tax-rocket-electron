export function advanceWizardCompletion(
  currentCompletionStep: number,
  reachedStep: number,
) {
  return Math.max(currentCompletionStep, reachedStep);
}

export function shrinkWizardCompletion(
  currentCompletionStep: number,
  resetStep: number,
) {
  return Math.min(currentCompletionStep, resetStep);
}

export function clampWizardLocation(
  currentStep: number,
  completionStep: number,
) {
  return Math.min(currentStep, completionStep);
}

export function isWizardStepCompleted(
  stepIndex: number,
  completionStep: number,
) {
  return stepIndex < completionStep;
}

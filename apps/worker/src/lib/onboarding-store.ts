/**
 * Persisted state for the Phase 1I onboarding wizard.
 *
 * Lives inside `shops.settings_json.onboarding` so it shares the
 * shallow-merge guarantees of the rest of the settings blob (DECISIONS #9
 * called this out for `app_proxy.subpath` — same applies here).
 *
 * Status lifecycle:
 *   pending   — first install, redirect from admin home until the merchant
 *               either finishes or dismisses
 *   completed — every required step is `done: true` and the merchant hit
 *               Finish on Step 7
 *   dismissed — merchant chose to skip the wizard entirely; admin home no
 *               longer redirects, but Settings has a "Resume setup" link
 *
 * Step 2 (migration) is intentionally absent — DECISIONS #12 keeps it as
 * a P1 polish item; the pilot's ~20 wholesale-tagged customers are imported
 * manually.
 */

import type { SettingsBlob } from './settings.js';

export const ONBOARDING_STEPS = [
  'detect',
  'tiers',
  'application',
  'assets',
  'test_buyer',
  'go_live',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export const SKIPPABLE_STEPS = new Set<OnboardingStepId>(['assets']);

export interface OnboardingStepState {
  done: boolean;
  skipped: boolean;
  completed_at?: number;
  data?: Record<string, unknown>;
}

export interface OnboardingState {
  status: 'pending' | 'completed' | 'dismissed';
  current_step: OnboardingStepId;
  steps: Record<OnboardingStepId, OnboardingStepState>;
  started_at: number;
  completed_at?: number;
  dismissed_at?: number;
}

function emptyStepState(): OnboardingStepState {
  return { done: false, skipped: false };
}

export function defaultOnboardingState(now: number = Math.floor(Date.now() / 1000)): OnboardingState {
  const steps = {} as Record<OnboardingStepId, OnboardingStepState>;
  for (const id of ONBOARDING_STEPS) steps[id] = emptyStepState();
  return {
    status: 'pending',
    current_step: 'detect',
    steps,
    started_at: now,
  };
}

export function readOnboardingState(blob: SettingsBlob): OnboardingState {
  const raw = (blob as { onboarding?: unknown }).onboarding;
  if (!raw || typeof raw !== 'object') return defaultOnboardingState();
  const candidate = raw as Partial<OnboardingState>;
  if (
    candidate.status !== 'pending' &&
    candidate.status !== 'completed' &&
    candidate.status !== 'dismissed'
  ) {
    return defaultOnboardingState();
  }
  const base = defaultOnboardingState(candidate.started_at ?? Math.floor(Date.now() / 1000));
  const steps = { ...base.steps };
  if (candidate.steps && typeof candidate.steps === 'object') {
    for (const id of ONBOARDING_STEPS) {
      const s = (candidate.steps as Record<string, unknown>)[id];
      if (s && typeof s === 'object') {
        const obj = s as Partial<OnboardingStepState>;
        steps[id] = {
          done: obj.done === true,
          skipped: obj.skipped === true,
          completed_at: typeof obj.completed_at === 'number' ? obj.completed_at : undefined,
          data: obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined,
        };
      }
    }
  }
  const currentStep =
    typeof candidate.current_step === 'string' &&
    (ONBOARDING_STEPS as readonly string[]).includes(candidate.current_step)
      ? (candidate.current_step as OnboardingStepId)
      : nextIncompleteStep(steps);
  return {
    status: candidate.status,
    current_step: currentStep,
    steps,
    started_at: base.started_at,
    completed_at: typeof candidate.completed_at === 'number' ? candidate.completed_at : undefined,
    dismissed_at: typeof candidate.dismissed_at === 'number' ? candidate.dismissed_at : undefined,
  };
}

export function writeOnboardingState(blob: SettingsBlob, state: OnboardingState): SettingsBlob {
  return { ...blob, onboarding: state };
}

export function nextIncompleteStep(
  steps: Record<OnboardingStepId, OnboardingStepState>,
): OnboardingStepId {
  for (const id of ONBOARDING_STEPS) {
    const s = steps[id];
    if (!s.done && !s.skipped) return id;
  }
  return ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
}

export function allRequiredStepsComplete(state: OnboardingState): boolean {
  for (const id of ONBOARDING_STEPS) {
    const s = state.steps[id];
    if (s.done) continue;
    if (s.skipped && SKIPPABLE_STEPS.has(id)) continue;
    return false;
  }
  return true;
}

export function markStepDone(
  state: OnboardingState,
  id: OnboardingStepId,
  data?: Record<string, unknown>,
  now: number = Math.floor(Date.now() / 1000),
): OnboardingState {
  const steps = {
    ...state.steps,
    [id]: { done: true, skipped: false, completed_at: now, data },
  };
  return {
    ...state,
    steps,
    current_step: nextIncompleteStep(steps),
  };
}

export function markStepSkipped(
  state: OnboardingState,
  id: OnboardingStepId,
  now: number = Math.floor(Date.now() / 1000),
): OnboardingState {
  if (!SKIPPABLE_STEPS.has(id)) {
    throw new Error(`step ${id} is not skippable`);
  }
  const steps = {
    ...state.steps,
    [id]: { done: false, skipped: true, completed_at: now },
  };
  return {
    ...state,
    steps,
    current_step: nextIncompleteStep(steps),
  };
}

export function dismissOnboarding(
  state: OnboardingState,
  now: number = Math.floor(Date.now() / 1000),
): OnboardingState {
  return { ...state, status: 'dismissed', dismissed_at: now };
}

export function completeOnboarding(
  state: OnboardingState,
  now: number = Math.floor(Date.now() / 1000),
): OnboardingState {
  if (!allRequiredStepsComplete(state)) {
    throw new Error('cannot complete onboarding: required steps still pending');
  }
  return { ...state, status: 'completed', completed_at: now };
}

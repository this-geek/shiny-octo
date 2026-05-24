import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STEPS,
  allRequiredStepsComplete,
  completeOnboarding,
  defaultOnboardingState,
  dismissOnboarding,
  markStepDone,
  markStepSkipped,
  nextIncompleteStep,
  readOnboardingState,
  writeOnboardingState,
} from './onboarding-store.js';

describe('onboarding-store', () => {
  it('defaults to pending status on step 1', () => {
    const s = defaultOnboardingState(1000);
    expect(s.status).toBe('pending');
    expect(s.current_step).toBe('detect');
    expect(s.started_at).toBe(1000);
    for (const id of ONBOARDING_STEPS) {
      expect(s.steps[id].done).toBe(false);
      expect(s.steps[id].skipped).toBe(false);
    }
  });

  it('round-trips through the settings blob', () => {
    const state = defaultOnboardingState(42);
    const blob = writeOnboardingState({ brand: { primaryColor: '#000000' } } as never, state);
    const round = readOnboardingState(blob);
    expect(round.status).toBe('pending');
    expect(round.started_at).toBe(42);
    expect((blob as { brand?: unknown }).brand).toEqual({ primaryColor: '#000000' });
  });

  it('falls back to defaults when blob is missing or invalid', () => {
    expect(readOnboardingState({}).status).toBe('pending');
    expect(readOnboardingState({ onboarding: 'not an object' } as never).status).toBe('pending');
    expect(readOnboardingState({ onboarding: { status: 'garbage' } } as never).status).toBe('pending');
  });

  it('markStepDone advances current_step to the next incomplete step', () => {
    let s = defaultOnboardingState(1);
    s = markStepDone(s, 'detect', { foo: 1 }, 100);
    expect(s.steps.detect.done).toBe(true);
    expect(s.steps.detect.data).toEqual({ foo: 1 });
    expect(s.steps.detect.completed_at).toBe(100);
    expect(s.current_step).toBe('tiers');
  });

  it('markStepSkipped only works for skippable steps', () => {
    const s = defaultOnboardingState(1);
    expect(() => markStepSkipped(s, 'tiers')).toThrow();
    const skipped = markStepSkipped(s, 'assets', 200);
    expect(skipped.steps.assets.skipped).toBe(true);
    expect(skipped.steps.assets.done).toBe(false);
    expect(skipped.steps.assets.completed_at).toBe(200);
  });

  it('allRequiredStepsComplete is true once every required step is done and the skippable one is either done or skipped', () => {
    let s = defaultOnboardingState(1);
    for (const id of ONBOARDING_STEPS) {
      if (id === 'assets') s = markStepSkipped(s, 'assets');
      else s = markStepDone(s, id);
    }
    expect(allRequiredStepsComplete(s)).toBe(true);
  });

  it('completeOnboarding refuses if a required step is still pending', () => {
    let s = defaultOnboardingState(1);
    s = markStepDone(s, 'detect');
    expect(() => completeOnboarding(s)).toThrow();
  });

  it('completeOnboarding flips status when everything is ready', () => {
    let s = defaultOnboardingState(1);
    for (const id of ONBOARDING_STEPS) s = markStepDone(s, id);
    const done = completeOnboarding(s, 999);
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBe(999);
  });

  it('dismissOnboarding flips status and stamps dismissed_at', () => {
    const s = dismissOnboarding(defaultOnboardingState(1), 555);
    expect(s.status).toBe('dismissed');
    expect(s.dismissed_at).toBe(555);
  });

  it('nextIncompleteStep returns the first step that is neither done nor skipped', () => {
    let s = defaultOnboardingState(1);
    s = markStepDone(s, 'detect');
    s = markStepDone(s, 'tiers');
    expect(nextIncompleteStep(s.steps)).toBe('application');
    s = markStepSkipped(markStepDone(markStepDone(s, 'application'), 'test_buyer'), 'assets');
    expect(nextIncompleteStep(s.steps)).toBe('go_live');
  });
});

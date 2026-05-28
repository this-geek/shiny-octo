import { defineConfig } from '@playwright/test';

const THEMES = ['dawn', 'horizon', 'impulse', 'prestige'] as const;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: THEMES.map((theme) => ({
    name: theme,
    metadata: { theme },
  })),
});

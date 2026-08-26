import { describe, expect, it } from 'vitest';
import { tutorialEizouden } from '../src/i18n/tutorial-eizouden';
import type { Locale } from '../src/i18n/types';

describe('tutorialEizouden dictionary', () => {
  const locales: Locale[] = ['id', 'ja', 'en'];

  it('contains entries for all 3 supported locales (id, ja, en)', () => {
    locales.forEach((locale) => {
      expect(tutorialEizouden[locale]).toBeDefined();
      expect(tutorialEizouden[locale].metaTitle).toBeTruthy();
      expect(tutorialEizouden[locale].metaDescription).toBeTruthy();
      expect(tutorialEizouden[locale].lead).toBeTruthy();
      expect(tutorialEizouden[locale].prerequisitesHeading).toBeTruthy();
      expect(tutorialEizouden[locale].prerequisites.length).toBeGreaterThan(0);
      expect(tutorialEizouden[locale].windowsHeading).toBeTruthy();
      expect(tutorialEizouden[locale].androidHeading).toBeTruthy();
      expect(tutorialEizouden[locale].nextHeading).toBeTruthy();
      expect(tutorialEizouden[locale].nextBody).toBeTruthy();
      expect(tutorialEizouden[locale].copyLabel).toBeTruthy();
      expect(tutorialEizouden[locale].copiedLabel).toBeTruthy();
    });
  });

  it('has exactly 5 Windows steps for all locales', () => {
    locales.forEach((locale) => {
      expect(tutorialEizouden[locale].windowsSteps).toHaveLength(5);
    });
  });

  it('has exactly 6 Android steps for all locales', () => {
    locales.forEach((locale) => {
      expect(tutorialEizouden[locale].androidSteps).toHaveLength(6);
    });
  });

  it('has identical, exact install commands across all locales pointing to the entei.gorakudo.org short wrapper (latest stable)', () => {
    const expectedWinCmd =
      'irm https://entei.gorakudo.org/eizouden-install.ps1 | iex';
    const expectedAndroidCmd =
      'curl -fsSL https://entei.gorakudo.org/eizouden-install.sh | bash';

    locales.forEach((locale) => {
      const data = tutorialEizouden[locale];
      // Windows step 2 has the install command
      expect(data.windowsSteps[1]?.code).toBe(expectedWinCmd);
      expect(data.windowsSteps[1]?.code).not.toContain('github.com');
      expect(data.windowsSteps[1]?.code).toContain(
        'entei.gorakudo.org/eizouden-install'
      );
      // Windows step 5 has the launch command
      expect(data.windowsSteps[4]?.code).toBe('grkd-edds');

      // Android step 3 has the install command
      expect(data.androidSteps[2]?.code).toBe(expectedAndroidCmd);
      expect(data.androidSteps[2]?.code).not.toContain('github.com');
      expect(data.androidSteps[2]?.code).toContain(
        'entei.gorakudo.org/eizouden-install'
      );
      // Android step 5 has the launch command
      expect(data.androidSteps[4]?.code).toBe('grkd-edds');
    });
  });

  it('does not contain rc.XX release references anywhere in tutorial content', () => {
    const rawJson = JSON.stringify(tutorialEizouden);
    expect(rawJson).not.toMatch(/rc\.[0-9]+/i);
    expect(rawJson).not.toMatch(/rc-[0-9]+/i);
  });

  it('does not leak developer jargon (minisign, DPAPI, signature, bootstrap) in prose text', () => {
    locales.forEach((locale) => {
      const data = tutorialEizouden[locale];
      // Prose fields only — `code` is excluded because "bootstrap"
      // legitimately appears inside release download URLs.
      const winText = data.windowsSteps
        .map((s) => `${s.title} ${s.body} ${s.codeNote ?? ''} ${s.tip ?? ''}`)
        .join(' ');
      const androidText = data.androidSteps
        .map((s) => `${s.title} ${s.body} ${s.codeNote ?? ''} ${s.tip ?? ''}`)
        .join(' ');
      const prereqText = data.prerequisites.join(' ');
      const allText = `${data.metaTitle} ${data.metaDescription} ${data.heading} ${data.lead} ${prereqText} ${data.caution} ${data.nextBody} ${winText} ${androidText}`;

      expect(allText).not.toMatch(/minisign/i);
      expect(allText).not.toMatch(/dpapi/i);
      expect(allText).not.toMatch(/\bsignature\b/i);
      expect(allText).not.toMatch(/\bbootstrap\b/i);
    });
  });
});

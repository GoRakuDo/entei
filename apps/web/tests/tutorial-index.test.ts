import { describe, expect, it } from 'vitest';
import { tutorialIndex } from '../src/i18n/tutorial-index';
import type { Locale } from '../src/i18n/types';

describe('tutorialIndex dictionary', () => {
  const locales: Locale[] = ['id', 'ja', 'en'];

  it('contains entries for all 3 supported locales (id, ja, en)', () => {
    locales.forEach((locale) => {
      const data = tutorialIndex[locale];
      expect(data).toBeDefined();
      expect(data.metaTitle).toBeTruthy();
      expect(data.metaDescription).toBeTruthy();
      expect(data.heading).toBeTruthy();
      expect(data.lead).toBeTruthy();
      expect(data.itemsLabel).toBeTruthy();
      expect(data.items.length).toBeGreaterThan(0);
    });
  });

  it('has exactly 1 tutorial item with slug "eizoudendenshi" across all locales', () => {
    locales.forEach((locale) => {
      const items = tutorialIndex[locale].items;
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item).toBeDefined();
      if (item) {
        expect(item.slug).toBe('eizoudendenshi');
        expect(item.title).toBeTruthy();
        expect(item.description).toBeTruthy();
      }
    });
  });

  it('does not contain developer jargon (minisign, DPAPI, bootstrap, signature) in prose text', () => {
    locales.forEach((locale) => {
      const data = tutorialIndex[locale];
      const itemsText = data.items
        .map((item) => `${item.title} ${item.description}`)
        .join(' ');
      const allText = `${data.metaTitle} ${data.metaDescription} ${data.heading} ${data.lead} ${data.itemsLabel} ${itemsText}`;

      expect(allText).not.toMatch(/minisign/i);
      expect(allText).not.toMatch(/dpapi/i);
      expect(allText).not.toMatch(/\bsignature\b/i);
      expect(allText).not.toMatch(/\bbootstrap\b/i);
    });
  });
});

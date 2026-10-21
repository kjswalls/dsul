import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeUrl, packAction, packHref, packLabel, PackSchema, packText, siteOf } from '@/lib/prep-packs';
import { RESEARCH_MAX_USES, researchSupported } from '@/lib/ai-research';
import { researchOn } from '@/lib/background-prep';

/**
 * Research (memory/plans/power-mode.md, "Research"): the model may look things
 * up for a prep pack, behind its own switch, and the packs it brings back
 * carry their links. Every link is https; a bad one is dropped, never the pack.
 */

describe('the switch', () => {
  it('is off until turned on, and only some providers can search', () => {
    expect(researchOn(undefined)).toBe(false);
    expect(researchOn({ research: 'true' })).toBe(false);
    expect(researchOn({ research: true })).toBe(true);
    expect(['anthropic', 'openai', 'openrouter'].every((p) => researchSupported(p as never))).toBe(true);
    expect(['gemini', 'custom'].some((p) => researchSupported(p as never))).toBe(false);
    expect(RESEARCH_MAX_USES).toBeLessThanOrEqual(5);
  });

  it('is declared off in the settings manifest', () => {
    const src = readFileSync(join(process.cwd(), 'lib/settings/manifest.ts'), 'utf8');
    const record = src.slice(src.indexOf("id: 'extensions.doStuff.research'"));
    expect(record.slice(0, record.indexOf('},\n  {'))).toMatch(/defaultValue: false/);
  });
});

describe('links', () => {
  it('takes https only, with no credentials', () => {
    expect(isSafeUrl('https://nhs.uk/book')).toBe(true);
    expect(isSafeUrl('http://nhs.uk/book')).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('https://user:pw@nhs.uk')).toBe(false);
    expect(isSafeUrl('https://localhost/x')).toBe(false);
    expect(isSafeUrl(`https://a.com/${'x'.repeat(600)}`)).toBe(false);
    expect(siteOf('https://www.boots.com/a')).toBe('boots.com');
  });

  it('drops a bad source and keeps the pack', () => {
    const parsed = PackSchema.parse({
      kind: 'steps',
      steps: ['Pick a slot', 'Book it'],
      sources: [
        { title: 'Good', url: 'https://good.example/a' },
        { title: 'Bad', url: 'http://bad.example/a' },
        { url: 'javascript:alert(1)' },
        'nonsense',
      ],
    });
    expect(parsed.sources).toEqual([{ title: 'Good', url: 'https://good.example/a' }]);
  });
});

describe('the new kinds', () => {
  it('options: each with its own link, a bad link lost but the option kept', () => {
    const pack = PackSchema.parse({
      kind: 'options',
      intro: 'Three slots this week',
      options: [
        { title: 'Dr Patel', when: 'Tue 3pm', url: 'https://clinic.example/book' },
        { title: 'Dr Lee', when: 'Wed 9am', url: 'http://clinic.example/book' },
      ],
    });
    if (pack.kind !== 'options') throw new Error('kind');
    expect(pack.options[1].url).toBeUndefined();
    expect(packLabel(pack)).toBe('2 options');
    expect(packText(pack)).toContain('Dr Patel · Tue 3pm · https://clinic.example/book');
  });

  it('list, form and draft parse, label and copy', () => {
    const list = PackSchema.parse({ kind: 'list', items: ['milk', 'eggs'] });
    expect(packLabel(list)).toBe('list ready');
    expect(packAction(list)).toBe('Copy list');
    expect(packText(list)).toBe('- milk\n- eggs');

    const form = PackSchema.parse({ kind: 'form', url: 'https://gov.example/form', fields: [{ label: 'Name', value: 'Kirby' }] });
    expect(packHref(form)).toBe('https://gov.example/form');
    expect(packAction(form)).toBe('Open the form');
    expect(packText(form)).toBe('Name: Kirby');
    const noUrl = PackSchema.parse({ kind: 'form', url: 'ftp://x.example', fields: [{ label: 'Name', value: 'K' }] });
    expect(packHref(noUrl)).toBeNull();
    expect(packAction(noUrl)).toBe('Copy answers');

    const draft = PackSchema.parse({ kind: 'draft', title: 'Bio', body: 'I make planners.' });
    expect(packLabel(draft)).toBe('draft ready');
    expect(packText(draft)).toBe('Bio\n\nI make planners.');
  });
});

describe('migration 079', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/079_prep_research_kinds.sql'), 'utf8');
  it('lets every kind in, re-runnably', () => {
    for (const kind of ['email', 'message', 'call', 'steps', 'question', 'options', 'list', 'form', 'draft']) {
      expect(sql).toContain(`'${kind}'`);
    }
    expect(sql).toMatch(/if exists \(select 1 from pg_constraint where conname = 'prep_packs_kind_check'\)/);
  });
});

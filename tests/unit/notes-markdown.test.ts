import { describe, expect, it } from 'vitest';
import { notesCaretFor, notesLineCount, notesLineSpans } from '@/lib/notes-markdown';

const joined = (line: string) => notesLineSpans(line).map((s) => s.text).join('');

describe('notesLineSpans', () => {
  it('keeps every character, in order, so the painted copy wraps with the field', () => {
    for (const line of [
      '### Sun 11/8',
      '- Drive up (about 3.5–4 hrs)',
      '1. **Red Rock** at *dawn*',
      '> a [link](https://example.com) and `code`',
      'snake_case_name and **unclosed',
      '',
      '   ',
    ]) {
      expect(joined(line)).toBe(line);
    }
  });

  it('marks headings, list markers and inline markup', () => {
    expect(notesLineSpans('## Mon')).toEqual([
      { kind: 'marker', text: '## ' },
      { kind: 'heading', text: 'Mon' },
    ]);
    expect(notesLineSpans('- **O** at night').map((s) => s.kind)).toEqual(['marker', 'marker', 'strong', 'marker', 'text']);
    expect(notesLineSpans('[tickets](https://x.y)').map((s) => s.kind)).toEqual(['marker', 'link', 'marker']);
  });

  it('leaves an underscore inside a word alone', () => {
    expect(notesLineSpans('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }]);
  });
});

describe('notesLineCount', () => {
  it('counts lines with something on them', () => {
    expect(notesLineCount('a\n\n b\n  \nc')).toBe(3);
  });
});

describe('notesCaretFor', () => {
  const src = '### Sun\n- Drive up\n- **Secret Pizza**';

  it('finds the clicked words in the source, past the markers', () => {
    expect(notesCaretFor(src, 'Secret Pizza', 3, 0.9)).toBe(src.indexOf('Secret') + 3);
  });

  it('picks the match nearest where the click was', () => {
    const twice = 'Pool\nlunch\nPool';
    expect(notesCaretFor(twice, 'Pool', 1, 0.95)).toBe(twice.lastIndexOf('Pool') + 1);
    expect(notesCaretFor(twice, 'Pool', 1, 0.05)).toBe(1);
  });

  it('falls back to the ratio, and always stays inside the source', () => {
    expect(notesCaretFor(src, 'not there', 2, 0.5)).toBe(Math.round(src.length / 2));
    expect(notesCaretFor(src, '', 0, 2)).toBe(src.length);
  });
});

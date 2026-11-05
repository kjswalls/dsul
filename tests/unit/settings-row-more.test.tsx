import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SettingRow } from '@/components/settings/setting-row';
import type { SettingCtx, SettingRecord } from '@/lib/settings/manifest';
import { searchSettings } from '@/lib/settings/search';

/**
 * A description is one line; the rest sits behind a small More
 * (tests/unit/settings-one-line.test.ts holds the length). A screen reader
 * hears all of it either way, and search still finds words that only the
 * hidden part holds.
 */

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'u1' };

const record: SettingRecord = {
  id: 'test.more',
  pane: 'day',
  label: 'Leftovers',
  description: 'What you did not get to.',
  more: 'It stays there until you decide.',
  control: 'switch',
  keywords: [],
  read: () => false,
  write: () => {},
  defaultValue: false,
};

function renderRow(r: SettingRecord, quietDescription = false) {
  render(
    <SettingRow
      record={r}
      ctx={ctx}
      value={false}
      onWrite={() => {}}
      onReset={() => {}}
      quietDescription={quietDescription}
    />
  );
}

afterEach(cleanup);

describe('a row with More', () => {
  it('starts closed and opens on More', () => {
    renderRow(record);
    const more = screen.getByTestId('setting-more');
    expect(more).toHaveTextContent('More');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    const body = screen.getByText('It stays there until you decide.');
    expect(body).not.toBeVisible();

    fireEvent.click(more);
    expect(more).toHaveTextContent('Less');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more).toHaveAttribute('aria-controls', body.id);
    expect(body).toBeVisible();
  });

  it('describes the control with both parts, open or not', () => {
    renderRow(record);
    const control = screen.getByRole('switch');
    const ids = control.getAttribute('aria-describedby')!.split(' ');
    const said = ids.map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(said).toBe('What you did not get to. It stays there until you decide.');
  });

  it('shows no More when there is nothing more', () => {
    renderRow({ ...record, more: undefined });
    expect(screen.queryByTestId('setting-more')).toBeNull();
  });

  it('draws no More on a description kept for screen readers', () => {
    renderRow(record, true);
    expect(screen.queryByTestId('setting-more')).toBeNull();
  });
});

describe('search reads More', () => {
  it('finds a record by words only its More holds', () => {
    // A real record: the gateway row's More is the only place "pairing" is said.
    const hits = searchSettings('pairing each browser', ctx, { includeAdvanced: true });
    expect(hits.settings.map((h) => h.record.id)).toContain('beacon.gatewayUrl');
  });
});

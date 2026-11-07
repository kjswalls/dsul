import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SettingTray, trayFits } from '@/components/settings/setting-tray';
import { SETTINGS, type SettingRecord } from '@/lib/settings/manifest';

afterEach(cleanup);

const OPTS = [
  { value: 'bloom', label: 'Bloom' },
  { value: 'dusk', label: 'Dusk' },
] as const;

describe('trayFits', () => {
  const rec = (options: { value: string; label: string }[], control = 'enum') =>
    ({ id: 'x', control, options }) as unknown as SettingRecord;

  it('takes two or three short options, and nothing else', () => {
    expect(trayFits(rec([...OPTS]))).toBe(true);
    expect(trayFits(rec([{ value: 'a', label: 'A' }]))).toBe(false);
    expect(trayFits(rec(['a', 'b', 'c', 'd'].map((v) => ({ value: v, label: v }))))).toBe(false);
    expect(trayFits(rec([{ value: 'a', label: 'A long label here' }, { value: 'b', label: 'And another one' }]))).toBe(false);
    expect(trayFits(rec([...OPTS], 'toggle'))).toBe(false);
  });

  it('keeps longer lists in the manifest as menus', () => {
    for (const r of SETTINGS) {
      if (r.control === 'enum' && (r.options?.length ?? 0) > 3) expect(trayFits(r)).toBe(false);
    }
  });
});

describe('SettingTray', () => {
  it('is a radio group whose picked option is the one tab stop', () => {
    render(<SettingTray label="Far zoom" options={OPTS} value="dusk" testId="t" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Far zoom' });
    expect(group).toBe(screen.getByTestId('t'));
    const [bloom, dusk] = screen.getAllByRole('radio');
    expect(dusk).toHaveAttribute('aria-checked', 'true');
    expect(bloom).toHaveAttribute('aria-checked', 'false');
    expect(dusk.tabIndex).toBe(0);
    expect(bloom.tabIndex).toBe(-1);
  });

  it('a click picks, and clicking the picked one writes nothing', () => {
    const onChange = vi.fn();
    render(<SettingTray label="Far zoom" options={OPTS} value="bloom" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Bloom' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Dusk' }));
    expect(onChange).toHaveBeenCalledWith('dusk');
  });

  it('arrow keys move the pick and the focus, wrapping', () => {
    const onChange = vi.fn();
    render(<SettingTray label="Far zoom" options={OPTS} value="bloom" onChange={onChange} />);
    const bloom = screen.getByRole('radio', { name: 'Bloom' });
    fireEvent.keyDown(bloom, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('dusk');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Dusk' }));
    fireEvent.keyDown(bloom, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('dusk');
  });

  it('with no option picked, the first is the tab stop', () => {
    render(<SettingTray label="Far zoom" options={OPTS} value="nope" onChange={() => {}} />);
    const [bloom, dusk] = screen.getAllByRole('radio');
    expect(bloom.tabIndex).toBe(0);
    expect(dusk.tabIndex).toBe(-1);
  });
});

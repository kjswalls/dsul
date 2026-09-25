import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BucketCard } from '@/components/primitives/bucket-card';

afterEach(cleanup);

const halos = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="bucket-current-halo"]');

describe('current bucket glyph halo', () => {
  it.each(['spine', 'tray'] as const)('glows behind the current bucket only (%s)', (variant) => {
    const { container } = render(
      <>
        <BucketCard bucket="morning" count={0} isEmpty variant={variant}>
          {null}
        </BucketCard>
        <BucketCard bucket="afternoon" count={0} isEmpty isCurrent variant={variant}>
          {null}
        </BucketCard>
      </>
    );
    const found = halos(container);
    expect(found).toHaveLength(1);
    expect(found[0].closest('[data-bucket]')?.getAttribute('data-bucket')).toBe('afternoon');
    // Its stacking parent must isolate, or the -z-10 glow sinks under the
    // caption button's hover fill.
    expect(found[0].parentElement?.className).toContain('isolate');
  });

  it('holds still under both motion vetoes', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.bucket-now-glow \{\s*animation: none;/
    );
    expect(css).toMatch(/\[data-reduce-motion='true'\] \.bucket-now-glow \{\s*animation: none;/);
  });
});

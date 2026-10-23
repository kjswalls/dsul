import { Fragment } from 'react';
import type { CopyRun } from '@/lib/organize-copy';

/**
 * A shared sentence (lib/organize-copy.ts) with each count in the numeral face,
 * `font-num`, as the web drew those counts before the words moved into a pure
 * module. The text is exactly `runsText(runs)`; only the counts' face differs.
 */
export function CopyRuns({ runs }: { runs: readonly CopyRun[] }) {
  return (
    <>
      {runs.map((run, i) => (
        <Fragment key={i}>
          {typeof run === 'string' ? run : <span className="font-num">{run.count}</span>}
        </Fragment>
      ))}
    </>
  );
}

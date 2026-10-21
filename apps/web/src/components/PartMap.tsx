import { memo } from 'react';

export type PartMapTone = 'uploading' | 'processing' | 'ready' | 'failed' | 'paused';

interface Props {
  /** Per-part state: 0 waiting, 1 in flight, 2 uploaded. Omit when all parts are done. */
  states?: Uint8Array;
  partCount: number;
  tone: PartMapTone;
  label: string;
}

const MAX_CELLS = 120;

/**
 * One cell per S3 part (grouped into at most 120 cells for huge files). Cells fill as parts
 * land and pulse while a part is in flight, so the parallelism is visible at a glance.
 */
export const PartMap = memo(function PartMap({ states, partCount, tone, label }: Props) {
  const cells = Math.max(1, Math.min(partCount || 1, MAX_CELLS));
  const items = [];
  for (let c = 0; c < cells; c++) {
    const from = Math.floor((c * partCount) / cells);
    const to = Math.max(from + 1, Math.floor(((c + 1) * partCount) / cells));
    let done = 0;
    let active = false;
    for (let p = from; p < to; p++) {
      const s = states ? states[p] : 2;
      if (s === 2) done++;
      else if (s === 1) active = true;
    }
    const fill = done / (to - from);
    items.push(<i key={c} className={active ? 'cell is-active' : 'cell'} style={{ '--fill': `${Math.round(fill * 100)}%` } as React.CSSProperties} />);
  }
  return (
    <div className={`partmap tone-${tone}`} role="img" aria-label={label} style={{ gridTemplateColumns: `repeat(${cells}, 1fr)` }}>
      {items}
    </div>
  );
});

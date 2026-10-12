import type { FileStatus } from '@s3up/core';

const STEPS = ['Uploading', 'Uploaded', 'Processing', 'Ready'] as const;

/** Where a file is in its life: uploading → uploaded → processing → ready, or failed along the way. */
export function Stepper({ status }: { status: FileStatus }) {
  const failed = status === 'failed';
  const index = status === 'uploading' ? 0 : status === 'uploaded' ? 1 : status === 'processing' ? 2 : status === 'ready' ? 3 : 2;
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map((label, i) => {
        const state = failed && i === index ? 'failed' : i < index || status === 'ready' ? 'done' : i === index ? 'current' : 'todo';
        return (
          <li key={label} className={`step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="step-dot" aria-hidden="true" />
            {failed && i === index ? 'Failed' : label}
          </li>
        );
      })}
    </ol>
  );
}

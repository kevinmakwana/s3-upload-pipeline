import { runJob } from './job';

// The container's entry point (bundled by `npm run build -w @s3up/functions`). Everything of substance is in job.ts.
runJob(process.env)
  .then(({ exitCode }) => process.exit(exitCode))
  .catch((err) => {
    console.error(JSON.stringify({ message: 'job could not start', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });

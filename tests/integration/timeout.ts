// Per-project `testTimeout` isn't honoured by Jest, so set it from a setup file.
// The large-file test waits on a Lambda cold start inside LocalStack.
jest.setTimeout(10 * 60_000);

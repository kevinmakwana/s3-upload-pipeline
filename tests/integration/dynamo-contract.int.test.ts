import { DynamoFileStore, DynamoProcessingLedger, createDocClient } from '@s3up/data';
import { fileStoreContract } from '../../packages/data/src/testing/contract';

// The same behavioural contract as the in-memory twin, against real DynamoDB conditions.
fileStoreContract('DynamoDB (LocalStack)', () => {
  const doc = createDocClient();
  const table = process.env.TABLE_NAME!;
  return { store: new DynamoFileStore(doc, table), ledger: new DynamoProcessingLedger(doc, table) };
});

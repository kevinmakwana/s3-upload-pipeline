import { MemoryFileStore, MemoryLedger } from './memory';
import { fileStoreContract } from './testing/contract';

fileStoreContract('in-memory', () => ({ store: new MemoryFileStore(), ledger: new MemoryLedger() }));

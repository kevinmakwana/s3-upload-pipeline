import { useSyncExternalStore } from 'react';
import { manager } from './lib/runtime';

export function useManager() {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot);
}

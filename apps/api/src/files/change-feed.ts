import { Observable, interval, map } from 'rxjs';

/**
 * A wake-up call for the live file list: it emits when something about a user's files may have changed.
 * It carries no data. A listener reads the list itself and sends the client only what actually differs, so a
 * missed or repeated signal costs a read at most and can never show wrong data.
 */
export interface ChangeFeed {
  changes(userId: string): Observable<void>;
}

/** Wakes every listener on a timer. This is what the API did before change notifications existed, and it needs nothing but the table. */
export class PollingChangeFeed implements ChangeFeed {
  constructor(private readonly intervalMs: number) {}

  changes(): Observable<void> {
    return interval(this.intervalMs).pipe(map(() => undefined));
  }
}

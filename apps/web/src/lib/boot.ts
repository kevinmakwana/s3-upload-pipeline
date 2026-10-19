import type { OidcSession } from './oidc';
import type { RuntimeConfig } from './config';

/** What start-up learned (from /config.json) before the app was loaded. Empty in development. */
export interface Boot {
  config: RuntimeConfig;
  /** Present when the deployment signs users in through a hosted login page. */
  session?: OidcSession;
}

let current: Boot = { config: {} };

export const getBoot = (): Boot => current;
export const setBoot = (boot: Boot): void => {
  current = boot;
};

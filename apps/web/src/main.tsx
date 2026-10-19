import '@fontsource-variable/schibsted-grotesk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setBoot } from './lib/boot';
import { loadRuntimeConfig } from './lib/config';
import { OidcSession } from './lib/oidc';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

/** A page that cannot start says why, instead of staying blank. */
function showFailure(err: unknown) {
  const box = document.createElement('main');
  box.className = 'page';
  const h = document.createElement('h1');
  h.textContent = 'Cannot start';
  const p = document.createElement('p');
  p.className = 'lede';
  p.textContent = err instanceof Error ? err.message : String(err);
  box.append(h, p);
  document.getElementById('root')!.replaceChildren(box);
}

async function boot() {
  const config = await loadRuntimeConfig();
  if (config.auth?.mode === 'oidc') {
    const { mode: _mode, ...oidc } = config.auth;
    const session = new OidcSession({
      config: oidc,
      page: {
        origin: location.origin,
        pathname: location.pathname,
        search: location.search,
        assign: (url) => location.assign(url),
        replaceUrl: (url) => history.replaceState(null, '', url),
      },
      storage: sessionStorage,
      fetch: (url, init) => fetch(url, init),
    });
    // Completes a sign-in, or leaves for the login page (in which case the app never loads).
    if ((await session.start()) === 'redirecting') return;
    setBoot({ config, session });
  } else {
    setBoot({ config });
  }
  // The app reads its settings when it loads, so it loads only now.
  const { App } = await import('./App');
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot().catch(showFailure);

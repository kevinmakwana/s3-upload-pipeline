import { useEffect, useMemo } from 'react';
import type { FileDto } from '@s3up/core';
import { DropZone } from './components/DropZone';
import { FileRow } from './components/FileRow';
import { useManager } from './hooks';
import { watchFiles } from './lib/sse';
import { API_URL, authMode, getAuthHeaders, manager, userId } from './lib/runtime';
import type { LocalUpload } from './lib/manager';

type Row = { key: string; local?: LocalUpload; file?: FileDto; sort: string };

export function App() {
  const { local, files, connection, concurrency, hasMoreFiles, loadingMoreFiles } = useManager();

  useEffect(() => {
    const abort = new AbortController();
    void manager.restore();
    void manager.refreshFiles();
    void watchFiles({
      baseUrl: API_URL,
      getHeaders: getAuthHeaders,
      signal: abort.signal,
      onFiles: (page) => manager.applyFirstPage(page),
      onState: (s) => manager.setConnection(s),
    });
    return () => abort.abort();
  }, []);

  const rows = useMemo<Row[]>(() => {
    const byId = new Map(files.map((f) => [f.id, f]));
    const used = new Set<string>();
    const out: Row[] = local.map((l) => {
      const f = l.fileId ? byId.get(l.fileId) : undefined;
      if (f) used.add(f.id);
      return { key: l.localId, local: l, file: f, sort: f?.createdAt ?? '9999' };
    });
    for (const f of files) if (!used.has(f.id)) out.push({ key: f.id, file: f, sort: f.createdAt });
    return out.sort((a, b) => b.sort.localeCompare(a.sort));
  }, [local, files]);

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <h1>Large file uploads</h1>
          <p className="lede">
            Files go straight from your browser to S3 in parallel parts. Close the tab halfway and pick up where you left off.
          </p>
        </div>
        <div className="controls">
          <div className="stepper-control" role="group" aria-label="Parallel parts">
            <button type="button" className="btn btn-icon" aria-label="Fewer parallel parts" onClick={() => manager.setConcurrency(concurrency - 1)} disabled={concurrency <= 1}>
              −
            </button>
            <span className="stepper-value" title="Parts uploaded at the same time. Applies to the next upload or resume.">
              <b>{concurrency}</b> parallel parts
            </span>
            <button type="button" className="btn btn-icon" aria-label="More parallel parts" onClick={() => manager.setConcurrency(concurrency + 1)} disabled={concurrency >= 16}>
              +
            </button>
          </div>
          <p className={`conn conn-${connection}`} role="status">
            <span className="conn-dot" aria-hidden="true" />
            {connection === 'live' ? 'Live updates' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </p>
        </div>
      </header>

      <DropZone onFile={(file, handle) => void manager.add(file, handle)} />

      {rows.length === 0 ? (
        <p className="empty">No files yet. Drop one above to start an upload.</p>
      ) : (
        <ul className="rows">
          {rows.map((r) => (
            <FileRow key={r.key} local={r.local} file={r.file} />
          ))}
        </ul>
      )}

      {hasMoreFiles ? (
        <div className="more">
          <button type="button" className="btn" disabled={loadingMoreFiles} onClick={() => void manager.loadMoreFiles()}>
            {loadingMoreFiles ? 'Loading…' : 'Load older files'}
          </button>
        </div>
      ) : null}

      <footer className="foot">
        {authMode === 'demo' ? (
          <p>
            Signed in as <b>{userId}</b>, a demo identity. Your files live under <code>uploads/{userId}/</code>.
          </p>
        ) : (
          <p>Signed in. Your files are private to your account.</p>
        )}
      </footer>
    </main>
  );
}

import { useRef, useState } from 'react';
import type { FileDto, FileStatus } from '@s3up/core';
import { formatBytes, formatDuration, formatRate, shortHash } from '../lib/format';
import type { FileAction, LocalUpload } from '../lib/manager';
import { manager } from '../lib/runtime';
import { PartMap, type PartMapTone } from './PartMap';
import { Stepper } from './Stepper';

interface Props {
  local?: LocalUpload;
  file?: FileDto;
  action?: FileAction;
}

const BUSY = new Set(['idle', 'preparing', 'verifying', 'uploading', 'completing']);

export function FileRow({ local, file, action }: Props) {
  const picker = useRef<HTMLInputElement>(null);
  const name = local?.fileName ?? file!.fileName;
  const size = local?.size ?? file!.size;
  const status: FileStatus = local ? 'uploading' : file!.status;
  const partCount = local?.partCount || file?.partCount || 0;
  const busy = local ? BUSY.has(local.phase) : false;

  const tone: PartMapTone = local
    ? local.phase === 'error' ? 'failed' : busy ? 'uploading' : 'paused'
    : status === 'failed' ? 'failed' : status === 'ready' ? 'ready' : status === 'processing' || status === 'uploaded' ? 'processing' : 'uploading';

  const mapLabel = local
    ? `${local.partsDone} of ${local.partCount} parts uploaded`
    : `${partCount} of ${partCount} parts uploaded`;

  return (
    <li className="row">
      <div className="row-head">
        {file?.thumbnailUrl ? <img className="thumb" src={file.thumbnailUrl} alt="" width={44} height={44} /> : null}
        <div className="row-title">
          <h3 title={name}>{name}</h3>
          <p className="row-size">{formatBytes(size)}</p>
        </div>
        <Stepper status={status} />
      </div>

      <PartMap states={local?.partStates} partCount={partCount} tone={tone} label={mapLabel} />

      {local ? (
        <LocalDetails local={local} busy={busy} onPick={() => picker.current?.click()} />
      ) : (
        <ServerDetails file={file!} action={action} />
      )}

      {local?.phase === 'interrupted' && !local.canReopenFile ? (
        <input
          ref={picker}
          type="file"
          hidden
          data-testid="resume-input"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void manager.resume(local.localId, picked);
            e.target.value = '';
          }}
        />
      ) : null}
    </li>
  );
}

function LocalDetails({ local, busy, onPick }: { local: LocalUpload; busy: boolean; onPick(): void }) {
  const { phase } = local;
  const remaining = local.size - local.bytesUploaded;
  return (
    <>
      <div className="row-stats" aria-live="off">
        {phase === 'idle' || phase === 'preparing' ? <span>Preparing upload…</span> : null}
        {phase === 'verifying' ? <span>Checking parts already in S3…</span> : null}
        {phase === 'completing' ? <span>Finishing: S3 is verifying the file</span> : null}
        {phase === 'uploading' ? (
          <>
            <span className="stat-main">
              {formatBytes(local.bytesUploaded)} / {formatBytes(local.size)}
            </span>
            <span className="metric">
              {local.partsDone} of {local.partCount} parts
            </span>
            <span className="metric">{local.activeParts} in flight</span>
            <span className="metric">{formatRate(local.bytesPerSecond)}</span>
            <span className="metric">{local.etaSeconds !== undefined && remaining > 0 ? `${formatDuration(local.etaSeconds)} left` : null}</span>
          </>
        ) : null}
        {phase === 'paused' ? (
          <span>
            Paused at {formatBytes(local.bytesUploaded)} of {formatBytes(local.size)}
          </span>
        ) : null}
        {phase === 'interrupted' ? (
          <span>
            Interrupted with {local.partsDone} of {local.partCount} parts uploaded.{' '}
            {local.canReopenFile ? 'Resume to continue where it stopped.' : 'Choose the same file to continue where it stopped.'}
          </span>
        ) : null}
        {local.restarted ? <span>The earlier upload expired, so this one started over.</span> : null}
      </div>
      {local.error ? (
        <p className="row-error" role="alert">
          {local.error}
        </p>
      ) : null}
      <div className="row-actions">
        {busy && phase !== 'completing' ? (
          <button type="button" className="btn" onClick={() => manager.pause(local.localId)}>
            Pause
          </button>
        ) : null}
        {phase === 'paused' || phase === 'error' ? (
          <button type="button" className="btn btn-primary" onClick={() => void manager.resume(local.localId)}>
            {phase === 'error' ? 'Retry' : 'Resume'}
          </button>
        ) : null}
        {phase === 'interrupted' ? (
          <button type="button" className="btn btn-primary" onClick={() => (local.canReopenFile ? void manager.resume(local.localId) : onPick())}>
            {local.canReopenFile ? 'Resume' : 'Choose file to resume'}
          </button>
        ) : null}
        {phase !== 'completing' ? (
          <button type="button" className="btn btn-quiet" onClick={() => void manager.cancel(local.localId)}>
            Cancel upload
          </button>
        ) : null}
      </div>
    </>
  );
}

function ServerDetails({ file, action }: { file: FileDto; action?: FileAction }) {
  const r = file.result;
  return (
    <>
      <div className="row-stats">
        {file.status === 'uploading' ? <span>Upload started in another session; resume it from there.</span> : null}
        {file.status === 'uploaded' ? <span>Uploaded. Waiting for a worker to pick it up.</span> : null}
        {file.status === 'processing' ? <span>Computing checksum and extracting metadata…</span> : null}
        {file.status === 'ready' && r ? (
          <>
            <span className="metric" title={r.sha256}>
              SHA-256 {shortHash(r.sha256)}
            </span>
            {r.width && r.height ? (
              <span className="metric">
                {r.width} × {r.height} px
              </span>
            ) : null}
            {r.detectedType ? <span>{r.detectedType}</span> : <span>{file.contentType}</span>}
          </>
        ) : null}
      </div>
      {file.status === 'failed' ? (
        <p className="row-error" role="alert">
          {file.error ?? 'Processing failed.'}
        </p>
      ) : null}
      <FileActions file={file} action={action} />
    </>
  );
}

/** Download and delete for a finished file. Deleting asks for a second click instead of opening a dialog. */
function FileActions({ file, action }: { file: FileDto; action?: FileAction }) {
  const [confirming, setConfirming] = useState(false);
  const canDownload = file.status === 'ready';
  const canDelete = file.status === 'ready' || file.status === 'failed';
  if (!canDownload && !canDelete) return null;
  const busy = action?.busy;
  return (
    <>
      <div className="row-actions">
        {canDownload ? (
          <button type="button" className="btn" disabled={busy !== undefined} onClick={() => void manager.downloadFile(file.id)}>
            {busy === 'download' ? 'Preparing…' : 'Download'}
          </button>
        ) : null}
        {canDelete && !confirming ? (
          <button type="button" className="btn btn-quiet" disabled={busy !== undefined} onClick={() => setConfirming(true)}>
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        ) : null}
        {canDelete && confirming ? (
          <>
            <span className="confirm-text">Delete this file permanently?</span>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirming(false);
                void manager.deleteFile(file.id);
              }}
            >
              Delete permanently
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : null}
      </div>
      {action?.error ? (
        <p className="row-error" role="alert">
          {action.error}{' '}
          <button type="button" className="btn btn-quiet btn-inline" onClick={() => manager.dismissFileError(file.id)}>
            Dismiss
          </button>
        </p>
      ) : null}
    </>
  );
}

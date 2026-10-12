import { useRef, useState } from 'react';

interface Props {
  onFile(file: File, handle?: FileSystemFileHandle): void;
}

export function DropZone({ onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  async function choose() {
    // Chromium: the picker hands back a handle we can store, so a reload resumes with one click.
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ multiple: false });
        if (handle) return onFile(await handle.getFile(), handle);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    input.current?.click();
  }

  async function drop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const item = e.dataTransfer.items[0];
    const handle = (await item?.getAsFileSystemHandle?.().catch(() => null)) ?? undefined;
    if (handle && handle.kind === 'file') return onFile(await (handle as FileSystemFileHandle).getFile(), handle as FileSystemFileHandle);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div
      className={over ? 'dropzone is-over' : 'dropzone'}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <div>
        <p className="dropzone-title">Drop a file here</p>
        <p className="dropzone-hint">Multi-gigabyte files are fine. Each part goes straight to S3.</p>
      </div>
      <button type="button" className="btn btn-primary" onClick={choose}>
        Choose a file
      </button>
      <input
        ref={input}
        type="file"
        data-testid="file-input"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

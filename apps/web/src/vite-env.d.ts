/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API. Defaults to http://localhost:3001. */
  readonly VITE_API_URL?: string;
}

// File System Access API (Chromium). Used to resume an upload after a reload without re-picking the file.
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}
interface FileSystemFileHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface Window {
  showOpenFilePicker?(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
}
interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

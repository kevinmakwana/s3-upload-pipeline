/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API. Defaults to http://localhost:3001. */
  readonly VITE_API_URL?: string;
  /** "demo" (default) sends x-user-id; "bearer" sends a token from window.s3upAuth. */
  readonly VITE_AUTH_MODE?: 'demo' | 'bearer';
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

interface Window {
  /** Bring-your-own login: set this before the app loads when VITE_AUTH_MODE=bearer. */
  s3upAuth?: { getToken(): string | Promise<string> };
}

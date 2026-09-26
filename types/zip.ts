export type ArchiveFormat = 'zip' | '7z'

export interface ArchiveFileItem {
  id: string
  key: string
  path: string
  filename: string
  fileSize: number
  compressedSize: number
  modifiedAt: string
  encrypted: boolean
  format: ArchiveFormat
  read: (options?: { password?: string; signal?: AbortSignal }) => Promise<Blob>
}

export type ZipFileItem = ArchiveFileItem

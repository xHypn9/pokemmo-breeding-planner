import { readFileSync, writeFileSync } from 'node:fs'

export interface DriveBackupFile {
  id: string
  name: string
  createdTime: string
  size: number | null
  appVersion: string | null
  schemaVersion: number | null
}

export interface DriveBackupMetadata { appVersion: string; schemaVersion: number }
export interface AccessTokenProvider { accessToken(): Promise<string> }
type FetchLike = typeof fetch

interface DriveListResponse { files?: Array<{ id?: string; name?: string; createdTime?: string; size?: string; appProperties?: Record<string, string> }>; error?: { message?: string; status?: string } }

export class GoogleDriveService {
  constructor(private readonly auth: AccessTokenProvider, private readonly fetcher: FetchLike = fetch) {}

  async listBackups(): Promise<DriveBackupFile[]> {
    const params = new URLSearchParams({
      spaces: 'appDataFolder', pageSize: '100', orderBy: 'createdTime desc',
      q: "'appDataFolder' in parents and trashed = false and name contains 'PokeMMO-Breeding-Planner-'",
      fields: 'files(id,name,createdTime,size,appProperties)'
    })
    const payload = await this.requestJson<DriveListResponse>(`https://www.googleapis.com/drive/v3/files?${params}`)
    return (payload.files ?? []).filter((file) => file.id && file.name && file.createdTime).map((file) => ({
      id: file.id!, name: file.name!, createdTime: file.createdTime!, size: file.size ? Number(file.size) : null,
      appVersion: file.appProperties?.appVersion ?? null,
      schemaVersion: file.appProperties?.schemaVersion ? Number(file.appProperties.schemaVersion) : null
    })).sort((a, b) => b.createdTime.localeCompare(a.createdTime))
  }

  async upload(path: string, name: string, metadata: DriveBackupMetadata): Promise<DriveBackupFile> {
    const boundary = `pbp_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const file = readFileSync(path)
    const json = JSON.stringify({ name, parents: ['appDataFolder'], appProperties: { appVersion: metadata.appVersion, schemaVersion: String(metadata.schemaVersion) } })
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
      file, Buffer.from(`\r\n--${boundary}--`)
    ])
    const payload = await this.requestJson<{ id: string; name: string; createdTime: string; size?: string; appProperties?: Record<string, string> }>(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size,appProperties',
      { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body }
    )
    return { id: payload.id, name: payload.name, createdTime: payload.createdTime, size: payload.size ? Number(payload.size) : file.length, appVersion: payload.appProperties?.appVersion ?? metadata.appVersion, schemaVersion: Number(payload.appProperties?.schemaVersion ?? metadata.schemaVersion) }
  }

  async download(fileId: string, destination: string): Promise<void> {
    const token = await this.auth.accessToken()
    let response: Response
    try { response = await this.fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { authorization: `Bearer ${token}` } }) }
    catch { throw new Error('Google Drive could not be reached. Check your Internet connection and try again.') }
    if (!response.ok) throw await driveError(response, 'Cloud backup download failed')
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
  }

  async delete(fileId: string): Promise<void> {
    const token = await this.auth.accessToken()
    let response: Response
    try { response = await this.fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }) }
    catch { throw new Error('Google Drive could not be reached while removing an old backup. The new backup was kept.') }
    if (!response.ok && response.status !== 404) throw await driveError(response, 'Old cloud backup could not be deleted')
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.auth.accessToken()
    let response: Response
    try { response = await this.fetcher(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }) }
    catch { throw new Error('Google Drive could not be reached. Check your Internet connection and try again.') }
    if (!response.ok) throw await driveError(response, 'Google Drive request failed')
    return await response.json() as T
  }
}

async function driveError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = await response.json() as DriveListResponse
    const message = payload.error?.message
    if (response.status === 403) return new Error(message ?? 'Google Drive API denied the request. Confirm that Drive API is enabled and quota is available.')
    if (response.status === 401) return new Error('Google Drive authorization is no longer valid. Connect the account again.')
    return new Error(message ?? `${fallback} (${response.status})`)
  } catch { return new Error(`${fallback} (${response.status})`) }
}

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CloudBackupService, CloudStateStore, type BackupPort, type CloudAuthPort, type CloudDrivePort } from '../src/main/services/CloudBackupService'
import { EncryptedRefreshTokenStore, GoogleOAuthService, type EncryptionAdapter } from '../src/main/services/GoogleOAuthService'
import type { DriveBackupFile } from '../src/main/services/GoogleDriveService'

const temporary = () => mkdtempSync(join(tmpdir(), 'pbp-cloud-test-'))
const file = (index: number): DriveBackupFile => ({ id: `drive-file-${String(index).padStart(3, '0')}`, name: `PokeMMO-Breeding-Planner-${index}.zip`, createdTime: new Date(Date.UTC(2026, 8, 20, 12, index)).toISOString(), size: 100, appVersion: '0.2.17', schemaVersion: 2 })

class FakeAuth implements CloudAuthPort {
  connected = false; configured = true; connectCalls = 0; disconnectCalls = 0
  isConfigured = () => this.configured
  isConnected = () => this.connected
  async connect() { this.connectCalls++; this.connected = true }
  async disconnect() { this.disconnectCalls++; this.connected = false }
}

class FakeDrive implements CloudDrivePort {
  files: DriveBackupFile[] = []; uploads = 0; downloads = 0; deleted: string[] = []; failUpload = false
  async listBackups() { return [...this.files].sort((a, b) => b.createdTime.localeCompare(a.createdTime)) }
  async upload() { if (this.failUpload) throw new Error('upload failed'); this.uploads++; const uploaded = file(99); this.files.push(uploaded); return uploaded }
  async download(_id: string, destination: string) { this.downloads++; writeFileSync(destination, 'download') }
  async delete(id: string) { this.deleted.push(id); this.files = this.files.filter((entry) => entry.id !== id) }
}

class FakeBackup implements BackupPort {
  creates = 0; restores = 0; failRestore = false
  create(destination: string) { this.creates++; writeFileSync(destination, 'backup'); return destination }
  inspect() { return { appVersion: '0.2.17', schemaVersion: 2, createdAt: '2026-09-20T12:00:00.000Z' } }
  restore() { this.restores++; if (this.failRestore) throw new Error('corrupt backup') }
}

const setup = () => {
  const directory = temporary(); const auth = new FakeAuth(); const drive = new FakeDrive(); const backup = new FakeBackup()
  const cloud = new CloudBackupService(auth, drive, backup, new CloudStateStore(join(directory, 'state.json')))
  return { directory, auth, drive, backup, cloud }
}

describe('cloud backup orchestration', () => {
  it('starts disconnected without exposing credentials', () => {
    const { cloud } = setup(); const state = cloud.state()
    expect(state.connected).toBe(false); expect(state.dirty).toBe(true)
    expect(Object.keys(state)).not.toContain('accessToken'); expect(Object.keys(state)).not.toContain('refreshToken')
  })

  it('connects and discovers existing backups without uploading', async () => {
    const { cloud, auth, drive, backup } = setup(); drive.files = [file(1)]
    const state = await cloud.connect()
    expect(auth.connectCalls).toBe(1); expect(state.connected).toBe(true); expect(state.remoteBackupCount).toBe(1)
    expect(drive.uploads).toBe(0); expect(backup.creates).toBe(0)
  })

  it('uploads through the backup service and clears dirty only after success', async () => {
    const { cloud, auth, drive, backup, directory } = setup(); auth.connected = true
    const state = await cloud.upload()
    expect(backup.creates).toBe(1); expect(drive.uploads).toBe(1); expect(state.dirty).toBe(false)
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).dirty).toBe(false)
  })

  it('keeps dirty when upload fails', async () => {
    const { cloud, auth, drive } = setup(); auth.connected = true; drive.failUpload = true
    await expect(cloud.upload()).rejects.toThrow('upload failed')
    expect(cloud.state().dirty).toBe(true)
  })

  it('marks a newly changed database dirty after upload', async () => {
    const { cloud, auth } = setup(); auth.connected = true
    await cloud.upload(); expect(cloud.state().dirty).toBe(false)
    cloud.markDirty(); expect(cloud.state().dirty).toBe(true)
  })

  it('lists cloud backup metadata', async () => {
    const { cloud, auth, drive } = setup(); auth.connected = true; drive.files = [file(1), file(2)]
    const backups = await cloud.listBackups()
    expect(backups).toHaveLength(2); expect(backups[0]?.appVersion).toBe('0.2.17'); expect(backups[0]?.schemaVersion).toBe(2)
  })

  it('retains ten versions and deletes old files only after a successful upload', async () => {
    const { cloud, auth, drive } = setup(); auth.connected = true; drive.files = Array.from({ length: 11 }, (_, index) => file(index))
    await cloud.upload()
    expect(drive.deleted.length).toBe(2); expect(cloud.state().remoteBackupCount).toBe(10)
    const failed = setup(); failed.auth.connected = true; failed.drive.files = Array.from({ length: 11 }, (_, index) => file(index)); failed.drive.failUpload = true
    await expect(failed.cloud.upload()).rejects.toThrow(); expect(failed.drive.deleted).toEqual([])
  })

  it('downloads, inspects and restores through BackupService', async () => {
    const { cloud, auth, drive, backup } = setup(); auth.connected = true
    const result = await cloud.restore('drive-file-001')
    expect(drive.downloads).toBe(1); expect(backup.restores).toBe(1); expect(result.manifest.schemaVersion).toBe(2); expect(result.state.dirty).toBe(false)
  })

  it('does not change local cloud state when restore validation fails', async () => {
    const { cloud, auth, backup } = setup(); auth.connected = true; backup.failRestore = true
    await expect(cloud.restore('drive-file-001')).rejects.toThrow('corrupt backup')
    expect(cloud.state().dirty).toBe(true); expect(cloud.state().lastUploadFileId).toBeNull()
  })

  it('disconnects locally even when no upload was made', async () => {
    const { cloud, auth } = setup(); auth.connected = true
    const state = await cloud.disconnect()
    expect(auth.disconnectCalls).toBe(1); expect(state.connected).toBe(false); expect(state.dirty).toBe(true)
  })
})

describe('Google OAuth secure desktop flow', () => {
  const encryption = (): EncryptionAdapter => ({
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(`encrypted:${value}`),
    decrypt: (value) => value.toString().replace(/^encrypted:/, '')
  })

  it('stores only encrypted/base64 refresh-token data and deletes it on disconnect', async () => {
    const directory = temporary(); const path = join(directory, 'token.json'); const store = new EncryptedRefreshTokenStore(path, encryption())
    store.save('refresh-secret')
    const disk = readFileSync(path, 'utf8'); expect(disk).not.toContain('refresh-secret'); expect(store.load()).toBe('refresh-secret')
    const service = new GoogleOAuthService('client-id', store, async () => undefined, vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch)
    await service.disconnect(); expect(store.has()).toBe(false)
  })

  it('refuses plaintext storage when safe encryption is unavailable', () => {
    const store = new EncryptedRefreshTokenStore(join(temporary(), 'token.json'), { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
    expect(() => store.save('secret')).toThrow('not saved'); expect(store.has()).toBe(false)
  })

  it('completes loopback OAuth with PKCE and verified state', async () => {
    const store = new EncryptedRefreshTokenStore(join(temporary(), 'token.json'), encryption())
    const tokenFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }))
    let callbackHtml = ''
    const service = new GoogleOAuthService('client-id', store, async (authorizationUrl) => {
      const auth = new URL(authorizationUrl); expect(auth.searchParams.get('code_challenge_method')).toBe('S256'); expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.appdata')
      const callback = new URL(auth.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'code'); callback.searchParams.set('state', auth.searchParams.get('state')!)
      callbackHtml = await (await fetch(callback)).text()
    }, tokenFetch as unknown as typeof fetch, 2_000, 'client-secret')
    await service.connect(); expect(store.load()).toBe('refresh'); expect(service.isConnected()).toBe(true)
    const request = tokenFetch.mock.calls[0]?.[1] as RequestInit
    expect(new URLSearchParams(request.body as string).get('client_secret')).toBe('client-secret')
    expect(callbackHtml).toContain('place-items:center')
    expect(callbackHtml).toContain('id="seconds">5')
    expect(callbackHtml).toContain('window.close()')
  })

  it('reports a cancelled Google authorization and saves no token', async () => {
    const store = new EncryptedRefreshTokenStore(join(temporary(), 'token.json'), encryption())
    const service = new GoogleOAuthService('client-id', store, async (authorizationUrl) => {
      const auth = new URL(authorizationUrl); const callback = new URL(auth.searchParams.get('redirect_uri')!)
      callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('state', auth.searchParams.get('state')!); await fetch(callback)
    }, vi.fn() as unknown as typeof fetch, 2_000, 'client-secret')
    await expect(service.connect()).rejects.toThrow('cancelled'); expect(store.has()).toBe(false)
  })
})

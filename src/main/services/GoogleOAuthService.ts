import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface EncryptionAdapter {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface TokenFile { version: 1; ciphertext: string }

export class EncryptedRefreshTokenStore {
  constructor(readonly path: string, private readonly encryption: EncryptionAdapter) {}

  has(): boolean { return existsSync(this.path) }

  load(): string | null {
    if (!existsSync(this.path)) return null
    if (!this.encryption.isAvailable()) throw new Error('Secure credential storage is unavailable on this Windows account. Google Drive cannot be connected safely.')
    try {
      const payload = JSON.parse(readFileSync(this.path, 'utf8')) as TokenFile
      if (payload.version !== 1 || typeof payload.ciphertext !== 'string') throw new Error('invalid credential file')
      return this.encryption.decrypt(Buffer.from(payload.ciphertext, 'base64'))
    } catch (error) {
      throw new Error(`Saved Google Drive credentials could not be decrypted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  save(token: string): void {
    if (!this.encryption.isAvailable()) throw new Error('Secure credential storage is unavailable on this Windows account. The Google refresh token was not saved.')
    mkdirSync(dirname(this.path), { recursive: true })
    const payload: TokenFile = { version: 1, ciphertext: this.encryption.encrypt(token).toString('base64') }
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
  }

  clear(): void { rmSync(this.path, { force: true }) }
}

type FetchLike = typeof fetch
type OpenExternal = (url: string) => Promise<unknown>

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

export class GoogleOAuthService {
  private access: { token: string; expiresAt: number } | null = null

  constructor(
    private readonly clientId: string,
    private readonly tokens: EncryptedRefreshTokenStore,
    private readonly openExternal: OpenExternal,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 180_000,
    private readonly clientSecret = ''
  ) {}

  isConfigured(): boolean { return this.clientId.trim().length > 0 && this.clientSecret.trim().length > 0 }
  isConnected(): boolean { return this.tokens.has() }

  async connect(): Promise<void> {
    this.assertConfigured()
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const state = base64Url(randomBytes(32))
    const server = createServer()
    await listen(server)
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('OAuth loopback server could not obtain a local port') }
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
      client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.appdata', access_type: 'offline',
      prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256'
    }).toString()

    try {
      const callbackPromise = waitForCallback(server, state, this.timeoutMs).then(
        (code) => ({ code, error: null as Error | null }),
        (error: unknown) => ({ code: null, error: error instanceof Error ? error : new Error(String(error)) })
      )
      await this.openExternal(url.toString())
      const callback = await callbackPromise
      if (callback.error) throw callback.error
      const code = callback.code as string
      let response: Response
      try {
        const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
        response = await this.fetcher('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body
        })
      } catch { throw new Error('Google could not be reached. Check your Internet connection and try again.') }
      const payload = await readTokenResponse(response)
      if (!response.ok || !payload.access_token) throw oauthError(payload, 'Google rejected the authorization code')
      const refreshToken = payload.refresh_token ?? this.tokens.load()
      if (!refreshToken) throw new Error('Google did not return an offline refresh token. Disconnect the app in your Google account and try Connect again.')
      this.tokens.save(refreshToken)
      this.access = { token: payload.access_token, expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1_000 }
    } finally {
      await close(server)
    }
  }

  async accessToken(): Promise<string> {
    this.assertConfigured()
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token
    const refreshToken = this.tokens.load()
    if (!refreshToken) throw new Error('Google Drive is not connected')
    let response: Response
    try {
      const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
      response = await this.fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body
      })
    } catch { throw new Error('Google could not be reached. Check your Internet connection and try again.') }
    const payload = await readTokenResponse(response)
    if (!response.ok || !payload.access_token) {
      if (payload.error === 'invalid_grant') { this.tokens.clear(); this.access = null; throw new Error('Google Drive authorization was revoked or expired. Connect the account again.') }
      throw oauthError(payload, 'Google could not refresh the authorization')
    }
    this.access = { token: payload.access_token, expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1_000 }
    return this.access.token
  }

  async disconnect(): Promise<void> {
    let token: string | null = null
    try { token = this.tokens.load() } catch { /* Corrupt or unavailable credentials are still removed locally. */ }
    try {
      if (token) await this.fetcher(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    } catch { /* Revocation is best effort; local credentials are always removed. */ }
    finally { this.tokens.clear(); this.access = null }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new Error('Google OAuth desktop credentials are not configured for this build. See README: Google Drive setup.')
  }
}

const base64Url = (value: Buffer): string => value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function waitForCallback(server: Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Google sign-in timed out. Start Connect Google Drive again.')), timeoutMs)
    server.once('request', (request, response) => {
      clearTimeout(timer)
      const requested = new URL(request.url ?? '/', 'http://127.0.0.1')
      const state = requested.searchParams.get('state')
      const error = requested.searchParams.get('error')
      const code = requested.searchParams.get('code')
      const success = !error && state === expectedState && Boolean(code)
      response.writeHead(success ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(success
        ? callbackPage(true)
        : callbackPage(false))
      if (error) reject(new Error(error === 'access_denied' ? 'Google Drive connection was cancelled.' : `Google authorization failed: ${error}`))
      else if (state !== expectedState) reject(new Error('Google authorization returned an invalid state. No credentials were saved.'))
      else if (!code) reject(new Error('Google authorization did not return a code.'))
      else resolve(code)
    })
  })
}

function callbackPage(success: boolean): string {
  const title = success ? 'Google Drive connected' : 'Google Drive connection failed'
  const heading = success ? 'Google Drive connected successfully' : 'Google Drive connection failed'
  const detail = success
    ? 'Return to PokeMMO Breeding Planner. This tab will close automatically.'
    : 'Return to PokeMMO Breeding Planner and try again.'
  const icon = success ? '&#10003;' : '!'
  const autoClose = success
    ? `<p class="countdown">Closing in <strong id="seconds">5</strong> seconds...</p><script>
        history.replaceState(null, '', '/oauth2/complete');
        let remaining = 5;
        const seconds = document.getElementById('seconds');
        const timer = setInterval(() => {
          remaining -= 1;
          seconds.textContent = String(Math.max(0, remaining));
          if (remaining <= 0) {
            clearInterval(timer);
            window.close();
            setTimeout(() => { document.querySelector('.countdown').textContent = 'You can close this tab now.'; }, 250);
          }
        }, 1000);
      </script>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
    :root{color-scheme:dark;font-family:Inter,Segoe UI,system-ui,sans-serif;background:#080d16;color:#eef4ff}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 30%,#17233c 0,#0b1220 38%,#080d16 72%)}
    main{width:min(520px,100%);text-align:center;padding:48px 40px;border:1px solid #293a58;border-radius:22px;background:rgba(16,25,42,.96);box-shadow:0 24px 80px rgba(0,0,0,.45)}
    .icon{display:grid;place-items:center;width:72px;height:72px;margin:0 auto 24px;border-radius:50%;font-size:36px;font-weight:800;background:${success ? '#123f39' : '#4a2029'};color:${success ? '#5eead4' : '#fda4af'};border:1px solid ${success ? '#1f7469' : '#8b3545'}}
    h1{margin:0 0 14px;font-size:clamp(26px,5vw,36px);line-height:1.15}p{margin:0;color:#aebbd0;font-size:16px;line-height:1.6}.countdown{margin-top:24px;color:#8fa6ca}.countdown strong{color:#f5f8ff}
  </style></head><body><main><div class="icon">${icon}</div><h1>${heading}</h1><p>${detail}</p>${autoClose}</main></body></html>`
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  try { return await response.json() as TokenResponse } catch { return {} }
}

function oauthError(payload: TokenResponse, fallback: string): Error {
  return new Error(payload.error_description || payload.error || fallback)
}

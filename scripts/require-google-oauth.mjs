const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()

if (!clientId || !clientSecret) {
  console.error('Release installer requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.')
  process.exitCode = 1
}

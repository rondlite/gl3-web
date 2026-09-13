export async function storeRequest(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error(data.error || 'store_unavailable')
    error.status = response.status
    throw error
  }
  return data
}

export const installCommands = `npm config set @gl3-plugins:registry https://npm.gl3.dev
npm login --registry https://npm.gl3.dev --auth-type=legacy
npm install @gl3-plugins/market`

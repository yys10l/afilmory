import crypto from 'node:crypto'

import type { S3CompatibleConfig } from '../storage/interfaces'

export interface SimpleS3Client {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  buildObjectUrl: (key?: string) => string
  readonly bucket: string
  readonly region: string
}

type S3CompatibleProviderName = S3CompatibleConfig['provider']

const S3_COMPATIBLE_PROVIDERS = new Set(['s3', 'oss', 'cos'])

export function createS3Client(config: S3CompatibleConfig): SimpleS3Client {
  if (!S3_COMPATIBLE_PROVIDERS.has(config.provider)) {
    throw new Error('Storage provider is not S3-compatible')
  }

  const { accessKeyId, secretAccessKey, endpoint, bucket } = config
  const region = config.region ?? 'us-east-1'

  if (!bucket || bucket.trim().length === 0) {
    throw new Error('S3 bucket is required')
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('accessKeyId and secretAccessKey are required')
  }

  const baseUrl = buildBaseUrl({ bucket, region, endpoint, provider: config.provider })
  const sigV4Service = config.sigV4Service ?? inferSigV4Service(config.provider)

  const signer = new SigV4Signer({
    accessKeyId,
    secretAccessKey,
    sessionToken: config.sessionToken,
    region,
    service: sigV4Service,
  })

  return {
    bucket,
    region,
    fetch: async (input, init = {}) => {
      const fetchFn = globalThis.fetch?.bind(globalThis)
      if (!fetchFn) {
        throw new Error('Global fetch API is not available in this runtime.')
      }
      const url = new URL(typeof input === 'string' ? input : input.toString())
      const signed = await signer.sign(url, init)
      return await fetchFn(signed.url, signed.init)
    },
    buildObjectUrl: (key = '') => {
      if (!key) {
        return baseUrl
      }
      return `${baseUrl}${encodeS3Key(key)}`
    },
  }
}

function buildBaseUrl(params: {
  bucket: string
  region: string
  endpoint?: string
  provider: S3CompatibleProviderName
}): string {
  const { bucket, region, endpoint, provider } = params
  if (!endpoint) {
    switch (provider) {
      case 'oss': {
        return `https://${bucket}.${region}.aliyuncs.com/`
      }
      case 'cos': {
        return `https://${bucket}.cos.${region}.myqcloud.com/`
      }
      default: {
        const host = `s3.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`
        // S3's wildcard TLS certificate does not cover dotted bucket names.
        return bucket.includes('.') ? `https://${host}/${encodeRfc3986(bucket)}/` : `https://${bucket}.${host}/`
      }
    }
  }

  const explicitBucket = endpoint.includes('{bucket}')
  const url = parseS3BaseUrl(endpoint.replaceAll('{bucket}', bucket), 'S3 endpoint')
  const basePath = url.pathname.replace(/\/+$/, '')
  const hostname = url.hostname.toLowerCase()
  // Account/service hosts can themselves start with the bucket name (e.g. bucket "s3").
  const serviceEndpoint =
    /^s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(hostname) ||
    /^[^.]+(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(hostname) ||
    /^(?:oss-[^.]+\.aliyuncs\.com|cos\.[^.]+\.myqcloud\.com)$/.test(hostname)
  const bucketInHost = !serviceEndpoint && (hostname === bucket || hostname.startsWith(`${bucket}.`))
  const bucketInPath = safeDecodeURIComponent(basePath.slice(basePath.lastIndexOf('/') + 1)) === bucket

  if (explicitBucket || bucketInHost || bucketInPath) {
    url.pathname = `${basePath}/`
  } else if (provider === 'oss' || provider === 'cos' || /\.(?:aliyuncs\.com|myqcloud\.com)$/.test(hostname)) {
    url.hostname = `${bucket}.${hostname}`
    url.pathname = `${basePath}/`
  } else {
    // Generic S3 endpoints, including R2 account endpoints, keep their configured host.
    url.pathname = `${basePath}/${encodeRfc3986(bucket)}/`
  }
  return url.toString()
}

export function parseS3BaseUrl(value: string, name: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value)) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`)
  }
  url.pathname = canonicalizePath(url.pathname)
  return url
}

export function encodeS3Key(key: string): string {
  // WHATWG URL/fetch removes these segments before sending, changing the object key.
  // Fail explicitly instead of reading, overwriting or deleting a different object.
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('S3 object keys with standalone dot segments are not supported by fetch')
  }
  return key
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/')
}

function canonicalizePath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/'
  }

  const segments = pathname.split('/').map((segment) => encodeRfc3986(safeDecodeURIComponent(segment)))
  let canonical = segments.join('/')

  if (!canonical.startsWith('/')) {
    canonical = `/${canonical}`
  }

  if (pathname.endsWith('/') && !canonical.endsWith('/')) {
    canonical = `${canonical}/`
  }

  return canonical || '/'
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodeRfc3986(value: string): string {
  // eslint-disable-next-line unicorn/prefer-code-point
  return encodeURIComponent(value).replaceAll(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex')

function inferSigV4Service(provider: S3CompatibleProviderName): string {
  switch (provider) {
    case 'oss': {
      return 'oss'
    }
    default: {
      return 's3'
    }
  }
}

class SigV4Signer {
  constructor(
    private readonly options: {
      accessKeyId: string
      secretAccessKey: string
      sessionToken?: string
      region: string
      service: string
    },
  ) {}

  async sign(url: URL, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    // Use the same encoded path for the canonical request and the HTTP request.
    url.pathname = canonicalizePath(url.pathname)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers ?? {})
    headers.delete('authorization')

    headers.set('host', url.host)
    if (this.options.sessionToken) {
      headers.set('x-amz-security-token', this.options.sessionToken)
    }

    const body = init.body ?? null
    const payloadHash = await this.hashPayload(body)
    headers.set('x-amz-content-sha256', payloadHash)

    const now = new Date()
    const amzDate = toAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)

    headers.set('x-amz-date', amzDate)

    const canonicalRequest = this.buildCanonicalRequest(method, url, headers, payloadHash)
    const credentialScope = `${dateStamp}/${this.options.region}/${this.options.service}/aws4_request`
    const stringToSign = this.buildStringToSign(amzDate, credentialScope, canonicalRequest)
    const signingKey = this.deriveSigningKey(dateStamp)
    const signature = hmac(signingKey, stringToSign).toString('hex')

    const signedHeaders = this.getSignedHeaders(headers)
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    headers.set('authorization', authorization)

    const nextInit: RequestInit = {
      ...init,
      headers,
      body,
    }

    return { url: url.toString(), init: nextInit }
  }

  private getSignedHeaders(headers: Headers): string {
    const entries = Array.from(headers.entries()).map(([name]) => name.toLowerCase())
    const unique = Array.from(new Set(entries))
    unique.sort()
    return unique.join(';')
  }

  private buildCanonicalRequest(method: string, url: URL, headers: Headers, payloadHash: string): string {
    const canonicalUri = canonicalizePath(url.pathname)
    const canonicalQuery = buildCanonicalQuery(url.searchParams)
    const canonicalHeaders = buildCanonicalHeaders(headers)
    const signedHeaders = this.getSignedHeaders(headers)

    return `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  }

  private buildStringToSign(amzDate: string, credentialScope: string, canonicalRequest: string): string {
    const hashedRequest = hashHex(canonicalRequest)
    return `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedRequest}`
  }

  private deriveSigningKey(dateStamp: string): Buffer {
    const kDate = hmac(`AWS4${this.options.secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, this.options.region)
    const kService = hmac(kRegion, this.options.service)
    return hmac(kService, 'aws4_request')
  }

  private async hashPayload(body: BodyInit | null): Promise<string> {
    if (!body) {
      return EMPTY_HASH
    }

    if (typeof body === 'string') {
      return hashHex(body)
    }

    if (body instanceof ArrayBuffer) {
      return hashHex(Buffer.from(body))
    }

    if (ArrayBuffer.isView(body)) {
      const view = body as ArrayBufferView
      return hashHex(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
      return hashHex(body)
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      const buf = Buffer.from(await body.arrayBuffer())
      return hashHex(buf)
    }

    throw new Error('Unsupported body type for SigV4 signer')
  }
}

function buildCanonicalQuery(params: URLSearchParams): string {
  const entries: Array<{ key: string; value: string }> = []
  params.forEach((value, key) => {
    entries.push({ key: encodeRfc3986(key), value: encodeRfc3986(value) })
  })
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  entries.sort((a, b) => compare(a.key, b.key) || compare(a.value, b.value))
  return entries.map(({ key, value }) => `${key}=${value}`).join('&')
}

function buildCanonicalHeaders(headers: Headers): string {
  const pairs = Array.from(headers.entries()).map(([name, value]) => [
    name.toLowerCase(),
    value.trim().replaceAll(/\s+/g, ' '),
  ])
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return pairs.map(([name, value]) => `${name}:${value}\n`).join('')
}

function toAmzDate(date: Date): string {
  const yyyy = date.getUTCFullYear()
  const MM = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${MM}${dd}T${hh}${mm}${ss}Z`
}

function hashHex(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hmac(key: crypto.BinaryLike, value: crypto.BinaryLike): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest()
}

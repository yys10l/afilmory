import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { TestContext } from 'node:test'
import { test } from 'node:test'

import { createS3Client, encodeS3Key } from '../src/s3/client.js'
import type { S3CompatibleConfig } from '../src/storage/interfaces.js'
import { S3ProviderClient } from '../src/storage/providers/s3-client.js'
import { S3StorageProvider } from '../src/storage/providers/s3-provider.js'

// Public AWS documentation fixtures, never real credentials.
const config: S3CompatibleConfig = {
  provider: 's3',
  bucket: 'photos',
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

const endpoints: Array<[string, Partial<S3CompatibleConfig>, string]> = [
  ['AWS default', {}, 'https://photos.s3.us-east-1.amazonaws.com/'],
  ['AWS dotted bucket', { bucket: 'my.photos' }, 'https://s3.us-east-1.amazonaws.com/my.photos/'],
  [
    'AWS regional',
    { endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1' },
    'https://s3.eu-west-1.amazonaws.com/photos/',
  ],
  ['AWS global', { endpoint: 'https://s3.amazonaws.com' }, 'https://s3.amazonaws.com/photos/'],
  [
    'AWS China explicit',
    { endpoint: 'https://s3.cn-north-1.amazonaws.com.cn', region: 'cn-north-1' },
    'https://s3.cn-north-1.amazonaws.com.cn/photos/',
  ],
  ['AWS China default', { region: 'cn-north-1' }, 'https://photos.s3.cn-north-1.amazonaws.com.cn/'],
  [
    'AWS bucket host',
    { endpoint: 'https://photos.s3.us-east-1.amazonaws.com' },
    'https://photos.s3.us-east-1.amazonaws.com/',
  ],
  [
    'AWS dualstack',
    { endpoint: 'https://s3.dualstack.us-east-1.amazonaws.com' },
    'https://s3.dualstack.us-east-1.amazonaws.com/photos/',
  ],
  [
    'AWS hyphenated region',
    { endpoint: 'https://s3-us-east-1.amazonaws.com' },
    'https://s3-us-east-1.amazonaws.com/photos/',
  ],
  [
    'AWS service name collision',
    { bucket: 's3', endpoint: 'https://s3.us-east-1.amazonaws.com' },
    'https://s3.us-east-1.amazonaws.com/s3/',
  ],
  [
    'R2 account',
    { endpoint: 'https://account123.r2.cloudflarestorage.com', region: 'auto' },
    'https://account123.r2.cloudflarestorage.com/photos/',
  ],
  [
    'R2 jurisdiction',
    { endpoint: 'https://account123.eu.r2.cloudflarestorage.com', region: 'auto' },
    'https://account123.eu.r2.cloudflarestorage.com/photos/',
  ],
  [
    'R2 account substring',
    { bucket: 'abc', endpoint: 'https://012abc345.r2.cloudflarestorage.com' },
    'https://012abc345.r2.cloudflarestorage.com/abc/',
  ],
  [
    'R2 account equals bucket',
    { bucket: 'account123', endpoint: 'https://account123.r2.cloudflarestorage.com' },
    'https://account123.r2.cloudflarestorage.com/account123/',
  ],
  [
    'R2 explicit bucket host',
    { endpoint: 'https://photos.account123.r2.cloudflarestorage.com' },
    'https://photos.account123.r2.cloudflarestorage.com/',
  ],
  [
    'original PR DNS scenario (mock host)',
    { bucket: 'yys', endpoint: 'https://gallery.example.invalid' },
    'https://gallery.example.invalid/yys/',
  ],
  ['MinIO port and prefix', { endpoint: 'http://localhost:9000/gateway' }, 'http://localhost:9000/gateway/photos/'],
  ['IPv6', { endpoint: 'http://[::1]:9000' }, 'http://[::1]:9000/photos/'],
  [
    'bucket suffix in host',
    { endpoint: 'https://my-photos.example.invalid' },
    'https://my-photos.example.invalid/photos/',
  ],
  [
    'bucket in path substring',
    { endpoint: 'https://store.example.invalid/photos-api' },
    'https://store.example.invalid/photos-api/photos/',
  ],
  [
    'bucket in non-final path',
    { endpoint: 'https://store.example.invalid/photos/proxy' },
    'https://store.example.invalid/photos/proxy/photos/',
  ],
  [
    'bucket equals scheme substring',
    { bucket: 'https', endpoint: 'https://store.example.invalid' },
    'https://store.example.invalid/https/',
  ],
  [
    'existing bucket path',
    { endpoint: 'https://store.example.invalid/proxy/photos/' },
    'https://store.example.invalid/proxy/photos/',
  ],
  [
    'encoded bucket path',
    { endpoint: 'https://store.example.invalid/%70hotos/' },
    'https://store.example.invalid/photos/',
  ],
  ['bucket subdomain', { endpoint: 'https://photos.store.example.invalid/' }, 'https://photos.store.example.invalid/'],
  ['host template', { endpoint: 'https://{bucket}.store.example.invalid' }, 'https://photos.store.example.invalid/'],
  [
    'path template',
    { endpoint: 'https://store.example.invalid/{bucket}/proxy' },
    'https://store.example.invalid/photos/proxy/',
  ],
  [
    'multiple placeholders',
    { endpoint: 'https://{bucket}.store.example.invalid/{bucket}' },
    'https://photos.store.example.invalid/photos/',
  ],
  ['trailing slashes', { endpoint: 'https://store.example.invalid///' }, 'https://store.example.invalid/photos/'],
  ['OSS default', { provider: 'oss', region: 'oss-cn-hangzhou' }, 'https://photos.oss-cn-hangzhou.aliyuncs.com/'],
  [
    'OSS endpoint',
    { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com' },
    'https://photos.oss-cn-hangzhou.aliyuncs.com/',
  ],
  [
    'COS endpoint',
    { endpoint: 'https://cos.ap-shanghai.myqcloud.com' },
    'https://photos.cos.ap-shanghai.myqcloud.com/',
  ],
  ['COS default', { provider: 'cos', region: 'ap-shanghai' }, 'https://photos.cos.ap-shanghai.myqcloud.com/'],
  [
    'OSS bucket host',
    { provider: 'oss', endpoint: 'https://photos.oss-cn-hangzhou.aliyuncs.com' },
    'https://photos.oss-cn-hangzhou.aliyuncs.com/',
  ],
  [
    'encoded endpoint prefix',
    { endpoint: 'https://store.example.invalid/a%20b/%252F' },
    'https://store.example.invalid/a%20b/%252F/photos/',
  ],
  [
    'provider name in path',
    { endpoint: 'https://store.example.invalid/aliyuncs.com' },
    'https://store.example.invalid/aliyuncs.com/photos/',
  ],
  [
    'provider name in unrelated host',
    { endpoint: 'https://notaliyuncs.com.example.invalid' },
    'https://notaliyuncs.com.example.invalid/photos/',
  ],
]

for (const [name, overrides, base] of endpoints) {
  test(`endpoint: ${name}`, () => {
    const client = createS3Client({ ...config, ...overrides } as S3CompatibleConfig)
    assert.equal(client.buildObjectUrl(), base)
    assert.equal(client.buildObjectUrl('album/a.jpg'), `${base}album/a.jpg`)
  })
}

const keys = [
  ['album/秋 日.jpg', 'album/%E7%A7%8B%20%E6%97%A5.jpg'],
  ['a#b?c+d.jpg', 'a%23b%3Fc%2Bd.jpg'],
  ['100%/%2F.jpg', '100%25/%252F.jpg'],
  ["a!'()*.jpg", 'a%21%27%28%29%2A.jpg'],
  ['/a//b/', '/a//b/'],
  ['a\\b.jpg', 'a%5Cb.jpg'],
  ['emoji/📷.jpg', 'emoji/%F0%9F%93%B7.jpg'],
  ['%2e/%2E%2E/a.jpg', '%252e/%252E%252E/a.jpg'],
] as const

for (const [key, encoded] of keys) {
  test(`raw object key: ${key}`, () => {
    assert.equal(encodeS3Key(key), encoded)
    const provider = new S3StorageProvider(config)
    assert.equal(provider.generatePublicUrl(key), `https://photos.s3.us-east-1.amazonaws.com/${encoded}`)
    const cdn = new S3StorageProvider({ ...config, customDomain: 'https://cdn.example.invalid/assets/' })
    const publicUrl = cdn.generatePublicUrl(key)
    assert.equal(publicUrl, `https://cdn.example.invalid/assets/${encoded}`)
    assert.equal(new URL(publicUrl).search, '')
    assert.equal(new URL(publicUrl).hash, '')
    assert.equal(decodeURIComponent(new URL(publicUrl).pathname.slice('/assets/'.length)), key)
  })
}

test('customDomain strips trailing delimiters, never adds bucket or prefix', () => {
  const provider = new S3StorageProvider({
    ...config,
    prefix: 'album/',
    customDomain: 'https://cdn.example.invalid/root///',
  })
  assert.equal(provider.generatePublicUrl('album/a.jpg'), 'https://cdn.example.invalid/root/album/a.jpg')
})

for (const key of ['./a.jpg', 'a/../b.jpg', 'a/./b.jpg', '..']) {
  test(`reject key that fetch would silently normalize: ${key}`, () => {
    assert.throws(() => createS3Client(config).buildObjectUrl(key), /dot segments/i)
    assert.throws(
      () => new S3StorageProvider({ ...config, customDomain: 'https://cdn.example.invalid' }).generatePublicUrl(key),
      /dot segments/i,
    )
  })
}

for (const endpoint of [
  'store.example.invalid',
  'ftp://store.example.invalid',
  'https://user:pass@store.example.invalid',
  'https://store.example.invalid?route=photos',
  'https://store.example.invalid#photos',
]) {
  test(`reject ambiguous endpoint: ${endpoint}`, () => {
    assert.throws(() => createS3Client({ ...config, endpoint }), /endpoint/i)
  })
  test(`reject ambiguous customDomain: ${endpoint}`, () => {
    assert.throws(
      () => new S3StorageProvider({ ...config, customDomain: endpoint }).generatePublicUrl('a.jpg'),
      /customDomain/i,
    )
  })
}

function captureFetch(t: TestContext) {
  const requests: Array<{ url: URL; init: RequestInit; headers: Headers }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
    requests.push({ url: new URL(input), init, headers: new Headers(init.headers) })
    return new Response('<ListBucketResult/>', { status: 200 })
  })
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2013-05-24T00:00:00Z') })
  return requests
}

// Independent byte encoder/oracle: it does not call any production URL/signing helpers.
function uriEncode(value: string): string {
  return Array.from(Buffer.from(value), (byte) => {
    const char = String.fromCharCode(byte)
    return /[A-Za-z0-9_.~-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }).join('')
}

function verifySignature(
  request: { url: URL; init: RequestInit; headers: Headers },
  canonicalPath: string,
  canonicalQuery: string,
  region = 'us-east-1',
  payload = '',
) {
  const { headers, url, init } = request
  assert.equal(headers.get('host'), url.host)
  const payloadHash = createHash('sha256').update(payload).digest('hex')
  assert.equal(headers.get('x-amz-content-sha256'), payloadHash)
  const authorization = headers.get('authorization')!
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)![1]
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${headers.get(name)!.trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const canonical = [
    init.method ?? 'GET',
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const date = headers.get('x-amz-date')!
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join(
    '\n',
  )
  let key = Buffer.from(`AWS4${config.secretAccessKey}`)
  for (const component of [date.slice(0, 8), region, 's3', 'aws4_request']) {
    key = Buffer.from(createHmac('sha256', key).update(component).digest())
  }
  assert.equal(
    authorization,
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', key).update(stringToSign).digest('hex')}`,
  )
}

test('AWS published GET signature vector', async (t) => {
  const requests = captureFetch(t)
  const client = createS3Client({
    ...config,
    bucket: 'examplebucket',
    endpoint: 'https://examplebucket.s3.amazonaws.com',
  })
  await client.fetch(client.buildObjectUrl('test.txt'), { headers: { range: 'bytes=0-9' } })
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  assert.ok(
    requests[0].headers
      .get('authorization')!
      .endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'),
  )
})

test('AWS published PUT signature vector', async (t) => {
  const requests = captureFetch(t)
  const client = createS3Client({
    ...config,
    bucket: 'examplebucket',
    endpoint: 'https://examplebucket.s3.amazonaws.com',
  })
  await client.fetch(client.buildObjectUrl('test$file.text'), {
    method: 'PUT',
    body: 'Welcome to Amazon S3.',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
  })
  assert.ok(
    requests[0].headers
      .get('authorization')!
      .endsWith('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'),
  )
})

for (const [query, signature] of [
  ['lifecycle=', 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'],
  ['max-keys=2&prefix=J', '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'],
]) {
  test(`AWS published query signature vector: ${query}`, async (t) => {
    const requests = captureFetch(t)
    const client = createS3Client({
      ...config,
      bucket: 'examplebucket',
      endpoint: 'https://examplebucket.s3.amazonaws.com',
    })
    await client.fetch(`${client.buildObjectUrl()}?${query}`)
    assert.ok(requests[0].headers.get('authorization')!.endsWith(`Signature=${signature}`))
  })
}

for (const prefix of ['album/', '秋 日/#?+%/', "a!'()*/"]) {
  test(`list prefix is encoded once and signature matches: ${prefix}`, async (t) => {
    const requests = captureFetch(t)
    const provider = new S3StorageProvider({
      ...config,
      endpoint: 'https://account123.r2.cloudflarestorage.com',
      region: 'auto',
      prefix,
      maxFileLimit: 7,
    })
    await provider.listAllFiles()
    assert.equal(requests[0].url.searchParams.get('prefix'), prefix)
    verifySignature(requests[0], '/photos/', `list-type=2&max-keys=7&prefix=${uriEncode(prefix)}`, 'auto')
  })
}

test('query sorting uses encoded ASCII order including duplicate keys and empty values', async (t) => {
  const requests = captureFetch(t)
  const client = createS3Client(config)
  const url = new URL(client.buildObjectUrl())
  for (const [key, value] of [
    ['z', ''],
    ['a', 'z'],
    ['A', "!'()*"],
    ['a', 'A'],
    ['a', '/'],
    ['é', 'x'],
    ['a', ''],
  ]) {
    url.searchParams.append(key, value)
  }
  await client.fetch(url)
  verifySignature(requests[0], '/', '%C3%A9=x&A=%21%27%28%29%2A&a=&a=%2F&a=A&a=z&z=')
})

test('GET/HEAD/PUT/DELETE/COPY sign the actual encoded path; customDomain stays public-only', async (t) => {
  const requests = captureFetch(t)
  const settings = {
    ...config,
    endpoint: 'https://account123.r2.cloudflarestorage.com',
    region: 'auto',
    customDomain: 'https://cdn.example.invalid',
  }
  const client = new S3ProviderClient(settings)
  const key = "album/秋 日#?+%!'()*//a.jpg"
  const encoded = 'album/%E7%A7%8B%20%E6%97%A5%23%3F%2B%25%21%27%28%29%2A//a.jpg'
  await client.getObject(key)
  await client.headObject(key)
  await client.putObject(key, 'payload')
  await client.deleteObject(key)
  await client.copyObject(key, 'copy.jpg')
  assert.deepEqual(
    requests.map(({ init }) => init.method),
    ['GET', 'HEAD', 'PUT', 'DELETE', 'PUT'],
  )
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url.hostname, 'account123.r2.cloudflarestorage.com')
    const expectedPath = `/photos/${index === 4 ? 'copy.jpg' : encoded}`
    assert.equal(request.url.pathname, expectedPath)
    verifySignature(request, expectedPath, '', 'auto', index === 2 ? 'payload' : '')
  }
  assert.equal(requests[4].headers.get('x-amz-copy-source'), `/photos/${encoded}`)
  assert.equal(new S3StorageProvider(settings).generatePublicUrl(key), `https://cdn.example.invalid/${encoded}`)
})

test('canonical header order matches ASCII signed-header order', async (t) => {
  const requests = captureFetch(t)
  const client = createS3Client(config)
  await client.fetch(client.buildObjectUrl('a.jpg'), {
    headers: { 'x-amz-meta-a_': 'underscore', 'x-amz-meta-aa': 'letters', 'x-amz-meta-a-': 'hyphen' },
  })
  verifySignature(requests[0], '/a.jpg', '')
})

test('temporary session token is included in signed headers', async (t) => {
  const requests = captureFetch(t)
  const client = createS3Client({ ...config, sessionToken: 'EXAMPLE_SESSION_TOKEN' })
  await client.fetch(client.buildObjectUrl('a.jpg'))
  assert.equal(requests[0].headers.get('x-amz-security-token'), 'EXAMPLE_SESSION_TOKEN')
  assert.match(requests[0].headers.get('authorization')!, /SignedHeaders=[^,]*x-amz-security-token/)
  verifySignature(requests[0], '/a.jpg', '')
})

test('real fetch sends the same host, path and query to a loopback HTTP server', async (t) => {
  const received: Array<{ url: string; headers: Headers; body: string; method: string }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push({
      url: request.url!,
      headers: new Headers(request.headers as Record<string, string>),
      body: Buffer.concat(chunks).toString(),
      method: request.method!,
    })
    response.end('<ListBucketResult/>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/proxy`
  const client = new S3ProviderClient({ ...config, endpoint })
  await client.putObject('a #?%//b.jpg', 'payload')
  await client.listObjects({ prefix: '秋 日/#?%/', maxKeys: 3 })
  assert.equal(received[0].url, '/proxy/photos/a%20%23%3F%25//b.jpg')
  assert.equal(new URL(received[1].url, endpoint).searchParams.get('prefix'), '秋 日/#?%/')
  for (const [index, request] of received.entries()) {
    const url = new URL(request.url, endpoint)
    verifySignature(
      { url, headers: request.headers, init: { method: request.method } },
      url.pathname,
      index === 0 ? '' : `list-type=2&max-keys=3&prefix=${uriEncode('秋 日/#?%/')}`,
      'us-east-1',
      request.body,
    )
  }
})

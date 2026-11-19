import { beforeEach, expect, test, vi } from 'vitest'
import { deflateSync, gzipSync } from 'node:zlib'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { ElizaService, SayRequestSchema, SayResponseSchema, type SayRequest } from '@buf/connectrpc_eliza.bufbuild_es/connectrpc/eliza/v1/eliza_pb.js'
import { Code, ConnectError } from '@connectrpc/connect'
import { httpRouter } from 'convex/server'
import { registerService } from './index'

const say = vi.fn(async (_ctx: unknown, input: SayRequest) => create(SayResponseSchema, { sentence: input.sentence }))
const impl = {
  say,
  async converse() {
    throw new Error('unexpected converse call')
  },
  async introduce() {
    throw new Error('unexpected introduce call')
  },
}
const http = httpRouter()
registerService(http, ElizaService, impl)
const action = http.lookup('/connectrpc.eliza.v1.ElizaService/Say', 'POST')![0] as unknown as {
  _handler: (ctx: unknown, req: Request) => Promise<Response>
}
const authenticatedHttp = httpRouter()
registerService(authenticatedHttp, ElizaService, impl, {
  interceptors: [
    () => async () => {
      throw new ConnectError('missing identity', Code.Unauthenticated)
    },
  ],
})
const authenticatedAction = authenticatedHttp.lookup('/connectrpc.eliza.v1.ElizaService/Say', 'POST')![0] as unknown as {
  _handler: (ctx: unknown, req: Request) => Promise<Response>
}
const url = 'https://example.test/connectrpc.eliza.v1.ElizaService/Say'

beforeEach(() => {
  say.mockClear()
})

test('decodes an uncompressed JSON request', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"sentence":"hello"}',
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/json')
  expect(response.headers.get('Content-Encoding')).toBeNull()
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  expect(await response.json()).toEqual({ sentence: 'hello' })
})

test('decodes an uncompressed protobuf request', async () => {
  const body = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'hello' }))
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto' },
      body,
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/proto')
  expect(response.headers.get('Content-Encoding')).toBeNull()
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  const output = fromBinary(SayResponseSchema, new Uint8Array(await response.arrayBuffer()))
  expect(output.sentence).toBe('hello')
})

test('accepts explicit identity encoding for JSON', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' },
      body: '{"sentence":"hello"}',
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ sentence: 'hello' })
})

test('accepts explicit identity encoding for protobuf', async () => {
  const body = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'hello' }))
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'identity' },
      body,
    }),
  )
  expect(response.status).toBe(200)
  const output = fromBinary(SayResponseSchema, new Uint8Array(await response.arrayBuffer()))
  expect(output.sentence).toBe('hello')
})

test('decodes gzip JSON and returns an identity response', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Accept-Encoding': 'gzip',
      },
      body: gzipSync('{"sentence":"hello"}'),
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Encoding')).toBeNull()
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  expect(await response.json()).toEqual({ sentence: 'hello' })
})

test('decodes gzip protobuf and returns an identity response', async () => {
  const body = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'hello' }))
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/proto',
        'Content-Encoding': 'gzip',
        'Accept-Encoding': 'gzip',
      },
      body: gzipSync(body),
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Encoding')).toBeNull()
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  const output = fromBinary(SayResponseSchema, new Uint8Array(await response.arrayBuffer()))
  expect(output.sentence).toBe('hello')
})

test('gzip JSON reaches authentication', async () => {
  const response = await authenticatedAction._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gzipSync('{"sentence":"hello"}'),
    }),
  )
  expect(response.status).toBe(401)
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  expect(await response.json()).toEqual({ code: 'unauthenticated', message: 'missing identity' })
  expect(say).not.toHaveBeenCalled()
})

test('gzip protobuf reaches authentication', async () => {
  const body = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'hello' }))
  const response = await authenticatedAction._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'gzip' },
      body: gzipSync(body),
    }),
  )
  expect(response.status).toBe(401)
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  expect(await response.json()).toEqual({ code: 'unauthenticated', message: 'missing identity' })
  expect(say).not.toHaveBeenCalled()
})

test('unsupported brotli returns unimplemented and advertises gzip', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      body: '{}',
    }),
  )
  expect(response.status).toBe(501)
  expect(response.headers.get('Accept-Encoding')).toBe('gzip')
  expect(await response.json()).toEqual({ code: 'unimplemented', message: 'unknown compression "br": supported encodings are gzip' })
  expect(say).not.toHaveBeenCalled()
})

test('unsupported deflate returns unimplemented', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' },
      body: '{}',
    }),
  )
  expect(response.status).toBe(501)
  expect(await response.json()).toEqual({ code: 'unimplemented', message: 'unknown compression "deflate": supported encodings are gzip' })
  expect(say).not.toHaveBeenCalled()
})

test('stacked encodings return unimplemented', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip, identity' },
      body: '{}',
    }),
  )
  expect(response.status).toBe(501)
  expect(await response.json()).toEqual({ code: 'unimplemented', message: 'unknown compression "gzip, identity": supported encodings are gzip' })
  expect(say).not.toHaveBeenCalled()
})

test('an empty content-encoding header means identity', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': '' },
      body: '{"sentence":"hello"}',
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ sentence: 'hello' })
})

test('non-gzip bytes return invalid_argument before the handler runs', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: '{"sentence":"hello"}',
    }),
  )
  expect(response.status).toBe(400)
  const error = await response.json()
  expect(error.code).toBe('invalid_argument')
  expect(error.message).toMatch(/^decompress: /)
  expect(say).not.toHaveBeenCalled()
})

test('a zlib wrapper declared as gzip returns invalid_argument', async () => {
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: deflateSync('{"sentence":"hello"}'),
    }),
  )
  expect(response.status).toBe(400)
  const error = await response.json()
  expect(error.code).toBe('invalid_argument')
  expect(error.message).toMatch(/^decompress: /)
  expect(say).not.toHaveBeenCalled()
})

test('truncated gzip returns invalid_argument', async () => {
  const body = gzipSync('{"sentence":"hello"}').subarray(0, -1)
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
    }),
  )
  expect(response.status).toBe(400)
  const error = await response.json()
  expect(error.code).toBe('invalid_argument')
  expect(error.message).toMatch(/^decompress: /)
  expect(say).not.toHaveBeenCalled()
})

test('a bad gzip checksum returns invalid_argument', async () => {
  const body = gzipSync('{"sentence":"hello"}')
  body[body.length - 8] ^= 1
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
    }),
  )
  expect(response.status).toBe(400)
  const error = await response.json()
  expect(error.code).toBe('invalid_argument')
  expect(error.message).toMatch(/^decompress: /)
  expect(say).not.toHaveBeenCalled()
})

test('decodes gzip without native compression streams and skips empty bodies', async () => {
  vi.stubGlobal('DecompressionStream', undefined)
  try {
    const response = await action._handler(
      {},
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: gzipSync('{"sentence":"hello"}'),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sentence: 'hello' })

    const empty = await action._handler(
      {},
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'gzip' },
        body: new Uint8Array(),
      }),
    )
    expect(empty.status).toBe(200)
    expect((await empty.arrayBuffer()).byteLength).toBe(0)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('plain requests accept 4 MiB and reject one byte more before the handler runs', async () => {
  const atLimit = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'x'.repeat(4 * 1024 * 1024 - 5) }))
  expect(atLimit.length).toBe(4 * 1024 * 1024)
  const accepted = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto' },
      body: atLimit,
    }),
  )
  expect(accepted.status).toBe(200)
  expect(say).toHaveBeenCalledTimes(1)

  const overLimit = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'x'.repeat(4 * 1024 * 1024 - 4) }))
  expect(overLimit.length).toBe(4 * 1024 * 1024 + 1)
  const rejected = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto' },
      body: overLimit,
    }),
  )
  expect(rejected.status).toBe(429)
  expect(await rejected.json()).toEqual({ code: 'resource_exhausted', message: 'message is larger than configured max 4194304' })
  expect(say).toHaveBeenCalledTimes(1)
})

test('identity requests accept 4 MiB and reject one byte more before the handler runs', async () => {
  const atLimit = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'x'.repeat(4 * 1024 * 1024 - 5) }))
  expect(atLimit.length).toBe(4 * 1024 * 1024)
  const accepted = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'identity' },
      body: atLimit,
    }),
  )
  expect(accepted.status).toBe(200)
  expect(say).toHaveBeenCalledTimes(1)

  const overLimit = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'x'.repeat(4 * 1024 * 1024 - 4) }))
  expect(overLimit.length).toBe(4 * 1024 * 1024 + 1)
  const rejected = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'identity' },
      body: overLimit,
    }),
  )
  expect(rejected.status).toBe(429)
  expect(await rejected.json()).toEqual({ code: 'resource_exhausted', message: 'message is larger than configured max 4194304' })
  expect(say).toHaveBeenCalledTimes(1)
})

test('gzip requests accept 4 MiB of output and reject one byte more before the handler runs', async () => {
  const atLimit = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'x'.repeat(4 * 1024 * 1024 - 5) }))
  expect(atLimit.length).toBe(4 * 1024 * 1024)
  const accepted = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'gzip' },
      body: gzipSync(atLimit),
    }),
  )
  expect(accepted.status).toBe(200)
  expect(say).toHaveBeenCalledTimes(1)

  const overLimit = toBinary(SayRequestSchema, create(SayRequestSchema, { sentence: 'x'.repeat(4 * 1024 * 1024 - 4) }))
  expect(overLimit.length).toBe(4 * 1024 * 1024 + 1)
  const rejected = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'gzip' },
      body: gzipSync(overLimit),
    }),
  )
  expect(rejected.status).toBe(429)
  expect(await rejected.json()).toEqual({ code: 'resource_exhausted', message: 'message is larger than configured max 4194304' })
  expect(say).toHaveBeenCalledTimes(1)
})

test('stops reading and cancels an incoming body once it exceeds 4 MiB', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024))
        controller.enqueue(Uint8Array.of(0))
      },
      pull() {
        throw new Error('read beyond limit')
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Content-Encoding': 'gzip' },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({ code: 'resource_exhausted', message: 'message is larger than configured max 4194304' })
  expect(cancelled).toBe(true)
  expect(say).not.toHaveBeenCalled()
})

test('aborts gzip expansion before reaching a corrupt trailer beyond the limit', async () => {
  const body = gzipSync(JSON.stringify({ sentence: 'x'.repeat(8 * 1024 * 1024) }))
  body[body.length - 8] ^= 1
  expect(body.length).toBeLessThan(16 * 1024)
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
    }),
  )
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({ code: 'resource_exhausted', message: 'message is larger than configured max 4194304' })
  expect(say).not.toHaveBeenCalled()
})

test('counts output from all concatenated gzip members towards the limit', async () => {
  const body = Buffer.from(JSON.stringify({ sentence: 'x'.repeat(4 * 1024 * 1024) }))
  const midpoint = Math.floor(body.length / 2)
  const compressed = Buffer.concat([gzipSync(body.subarray(0, midpoint)), gzipSync(body.subarray(midpoint))])
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: compressed,
    }),
  )
  expect(response.status).toBe(429)
  expect(await response.json()).toEqual({ code: 'resource_exhausted', message: 'message is larger than configured max 4194304' })
  expect(say).not.toHaveBeenCalled()
})

test('body stream read failures return unknown', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('broken stream'))
    },
  })
  const response = await action._handler(
    {},
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto' },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ code: 'unknown', message: 'read message: broken stream' })
  expect(say).not.toHaveBeenCalled()
})

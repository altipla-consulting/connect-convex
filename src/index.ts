import { httpActionGeneric, type GenericActionCtx, type GenericDataModel, type HttpRouter } from 'convex/server'
import type { GenService, GenServiceMethods } from '@bufbuild/protobuf/codegenv2'
import { fromBinary, fromJsonString, toBinary, toJsonString, type DescMethod, type MessageShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { codeToHttpStatus, errorToJson } from '@connectrpc/connect/protocol-connect'
import { Inflate } from 'pako'

type ActionCtx = GenericActionCtx<GenericDataModel>

function serializeError(err: ConnectError) {
  return new Response(JSON.stringify(errorToJson(err, {})), {
    status: codeToHttpStatus(err.code),
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
    },
  })
}

const maxRequestBytes = 4 * 1024 * 1024

async function readBody(req: Request) {
  const encoding = req.headers.get('Content-Encoding')?.toLowerCase() || 'identity'
  if (encoding !== 'identity' && encoding !== 'gzip') {
    throw new ConnectError(`unknown compression ${JSON.stringify(encoding)}: supported encodings are gzip`, Code.Unimplemented)
  }
  if (!req.body) {
    return new Uint8Array()
  }

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = req.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.length
      if (size > maxRequestBytes) {
        await reader.cancel()
        throw new ConnectError(`message is larger than configured max ${maxRequestBytes}`, Code.ResourceExhausted)
      }
      chunks.push(value)
    }
  } catch (err: unknown) {
    if (err instanceof ConnectError) {
      throw err
    }
    throw new ConnectError(`read message: ${ConnectError.from(err).rawMessage}`, Code.Unknown)
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.length
  }
  if (encoding !== 'gzip' || !body.length) {
    return body
  }

  const inflater = new Inflate({ windowBits: 31, chunkSize: 64 * 1024 })
  let decompressedSize = 0
  inflater.onData = function (chunk) {
    decompressedSize += chunk.length
    if (decompressedSize > maxRequestBytes) {
      throw new ConnectError(`message is larger than configured max ${maxRequestBytes}`, Code.ResourceExhausted)
    }
    this.chunks.push(chunk)
  }
  if (!inflater.push(body, true)) {
    throw new ConnectError(`decompress: ${inflater.msg}`, Code.InvalidArgument)
  }
  return inflater.result
}

function isWireError(err: ConnectError) {
  // TODO(ernesto): Connect marks client errors with `isWireError` on main, but the field is not available in a release yet.
  // Replace this protocol-header heuristic with `err.isWireError` once a version containing connect-es#1717 is published.
  return err.metadata.has('content-type') || err.metadata.has('grpc-status') || err.metadata.has('grpc-status-details-bin')
}

export interface InterceptorRequest {
  service: GenService<GenServiceMethods>
  method: DescMethod
  message: unknown
  header: Headers
  raw: Request
}

type AnyHandler = (ctx: ActionCtx, req: InterceptorRequest) => Promise<unknown>

export type Interceptor = (next: AnyHandler) => AnyHandler

export type RegisterServiceOptions = {
  interceptors?: Interceptor[]
  ignoreUnknownFields?: boolean
}

export type Methods<T extends GenServiceMethods> = {
  [K in keyof T]: (ctx: ActionCtx, input: MessageShape<T[K]['input']>, req: Request) => Promise<MessageShape<T[K]['output']>>
}

export function registerService<T extends GenServiceMethods>(http: HttpRouter, service: GenService<T>, impl: Methods<T>, options?: RegisterServiceOptions) {
  for (const method of service.methods) {
    http.route({
      method: 'POST',
      path: `/${service.typeName}/${method.name}`,
      handler: httpActionGeneric(async (ctx, req) => {
        const contentType = req.headers.get('Content-Type')
        if (contentType !== 'application/json' && contentType !== 'application/proto') {
          console.warn('unknown content type', contentType)
          return new Response(`invalid content type ${contentType}`, { status: 400 })
        }

        let body: Uint8Array
        try {
          body = await readBody(req)
        } catch (err: unknown) {
          return serializeError(ConnectError.from(err, Code.InvalidArgument))
        }

        let input: any
        if (contentType === 'application/json') {
          try {
            input = fromJsonString(method.input, new TextDecoder().decode(body), {
              ignoreUnknownFields: options?.ignoreUnknownFields ?? false,
            })
          } catch (err: unknown) {
            console.warn('invalid json body', err)
            return serializeError(ConnectError.from(err, Code.InvalidArgument))
          }
        } else {
          try {
            input = fromBinary(method.input, body)
          } catch (err: unknown) {
            console.warn('invalid protobuf body', err)
            return serializeError(ConnectError.from(err, Code.InvalidArgument))
          }
        }

        try {
          const implName = method.name.charAt(0).toLowerCase() + method.name.slice(1)
          const inner: AnyHandler = async (ctx, interceptorReq) => {
            return await impl[implName](ctx, interceptorReq.message as any, interceptorReq.raw)
          }
          const handler = (options?.interceptors ?? []).reduceRight((next, interceptor) => interceptor(next), inner)
          const output = await handler(ctx, {
            service,
            method,
            message: input,
            header: req.headers,
            raw: req,
          })

          if (contentType === 'application/json') {
            return new Response(toJsonString(method.output, output as any), {
              headers: {
                'Content-Type': contentType,
                'Accept-Encoding': 'gzip',
              },
            })
          } else {
            return new Response(toBinary(method.output, output as any), {
              headers: {
                'Content-Type': contentType,
                'Accept-Encoding': 'gzip',
              },
            })
          }
        } catch (err: unknown) {
          if (err instanceof ConnectError && !isWireError(err)) {
            return serializeError(err)
          }
          throw err
        }
      }),
    })
  }
}

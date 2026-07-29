import { httpActionGeneric, type GenericActionCtx, type GenericDataModel, type HttpRouter } from 'convex/server'
import type { GenService, GenServiceMethods } from '@bufbuild/protobuf/codegenv2'
import { fromBinary, fromJsonString, toBinary, toJsonString, type DescMethod, type MessageShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { codeToHttpStatus, errorToJson } from '@connectrpc/connect/protocol-connect'

type ActionCtx = GenericActionCtx<GenericDataModel>

function serializeError(err: ConnectError) {
  return new Response(JSON.stringify(errorToJson(err, {})), {
    status: codeToHttpStatus(err.code),
    headers: { 'Content-Type': 'application/connect+proto' },
  })
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
}

export type Methods<T extends GenServiceMethods> = {
  [K in keyof T]: (ctx: ActionCtx, input: MessageShape<T[K]['input']>, req?: Request) => Promise<MessageShape<T[K]['output']>>
}

export function registerService<T extends GenServiceMethods>(http: HttpRouter, service: GenService<T>, impl: Methods<T>, options?: RegisterServiceOptions) {
  for (const method of service.methods) {
    http.route({
      method: 'POST',
      path: `/${service.typeName}/${method.name}`,
      handler: httpActionGeneric(async (ctx, req) => {
        let input: any

        const contentType = req.headers.get('Content-Type')
        if (contentType === 'application/connect+json' || contentType === 'application/json') {
          try {
            input = fromJsonString(method.input, await req.text())
          } catch (err: unknown) {
            return serializeError(ConnectError.from(err, Code.InvalidArgument))
          }
        } else if (contentType === 'application/connect+proto' || contentType === 'application/proto') {
          try {
            input = fromBinary(method.input, new Uint8Array(await req.arrayBuffer()))
          } catch (err: unknown) {
            return serializeError(ConnectError.from(err, Code.InvalidArgument))
          }
        } else {
          return new Response(`invalid content type ${contentType}`, { status: 400 })
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

          if (contentType === 'application/connect+json' || contentType === 'application/json') {
            return new Response(toJsonString(method.output, output as any), {
              headers: { 'Content-Type': contentType },
            })
          } else {
            return new Response(toBinary(method.output, output as any), {
              headers: { 'Content-Type': contentType },
            })
          }
        } catch (err: unknown) {
          if (err instanceof ConnectError) {
            return serializeError(err)
          }
          throw err
        }
      }),
    })
  }
}

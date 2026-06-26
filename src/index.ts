import { httpActionGeneric, type GenericActionCtx, type GenericDataModel, type HttpRouter } from 'convex/server'
import type { GenService, GenServiceMethods } from '@bufbuild/protobuf/codegenv2'
import { fromJsonString, toJsonString, type MessageShape } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { codeToHttpStatus, errorToJson } from '@connectrpc/connect/protocol-connect'

type ActionCtx = GenericActionCtx<GenericDataModel>

function serializeError(err: ConnectError) {
  return new Response(JSON.stringify(errorToJson(err, {})), {
    status: codeToHttpStatus(err.code),
    headers: { 'Content-Type': 'application/connect+proto' },
  })
}

type Methods<T extends GenServiceMethods> = {
  [K in keyof T]: (ctx: ActionCtx, input: MessageShape<T[K]['input']>, req?: Request) => Promise<MessageShape<T[K]['output']>>
}
export function registerService<T extends GenServiceMethods>(http: HttpRouter, service: GenService<T>, impl: Methods<T>) {
  for (const method of service.methods) {
    http.route({
      method: 'POST',
      path: `/${service.typeName}/${method.name}`,
      handler: httpActionGeneric(async (ctx, req) => {
        const contentType = req.headers.get('Content-Type')
        if (contentType !== 'application/connect+json' && contentType !== 'application/json') {
          return new Response(`invalid content type ${contentType}`, { status: 400 })
        }

        let input: any
        try {
          input = fromJsonString(method.input, await req.text())
        } catch (err: unknown) {
          return serializeError(ConnectError.from(err, Code.InvalidArgument))
        }

        try {
          const implName = method.name.charAt(0).toLowerCase() + method.name.slice(1)
          const output = await impl[implName](ctx, input)
          return new Response(toJsonString(method.output, output), {
            headers: { 'Content-Type': 'application/connect+proto' },
          })
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

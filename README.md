# connect-convex

Register Connect services in Convex.

Bridges [@connectrpc/connect](https://connectrpc.com) services with [Convex HTTP actions](https://docs.convex.dev/functions/http-actions).

## Install

```bash
pnpm add connect-convex
```

## Prerequisites

- A Convex project with `convex/http.ts`
- A protobuf service generated with `@bufbuild/protobuf` (codegenv2), e.g. via [Buf](https://buf.build)

## Example

Define a protobuf service:

```proto
syntax = "proto3";

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloResponse);
}

message HelloRequest {
  string name = 1;
}

message HelloResponse {
  string message = 1;
}
```

After codegen, import `GreeterService` from your generated file (path will vary).

Register the service in `convex/http.ts`:

```ts
import { httpRouter } from 'convex/server'
import { registerService } from 'connect-convex'
import { GreeterService } from './gen/greeter_pb'

const http = httpRouter()

registerService(http, GreeterService, {
  async sayHello(ctx, { name }) {
    return { message: `Hello, ${name}!` }
  },
})

export default http
```

- `ctx` is a Convex action context — use `runQuery`, `runMutation`, etc.
- RPC names map to camelCase keys in the impl object (`SayHello` → `sayHello`)
- Throw `ConnectError` from `@connectrpc/connect` for typed RPC errors

### Interceptors

Pass Connect-style interceptors via the optional fourth argument. They wrap every method on the service (first in the array is outermost) and receive the Convex `ActionCtx`:

```ts
import type { Interceptor } from 'connect-convex'
import { ConnectError, Code } from '@connectrpc/connect'

const auth: Interceptor = (next) => async (ctx, req) => {
  const token = req.header.get('Authorization')
  if (!token) {
    throw new ConnectError('missing authorization', Code.Unauthenticated)
  }
  return await next(ctx, req)
}

registerService(
  http,
  GreeterService,
  {
    async sayHello(ctx, { name }) {
      return { message: `Hello, ${name}!` }
    },
  },
  { interceptors: [auth] },
)
```

Throwing a `ConnectError` from an interceptor short-circuits the chain and is returned as a typed RPC error.

Call the endpoint:

```bash
curl -X POST "https://<deployment>.convex.site/Greeter/SayHello" \
  -H "Content-Type: application/connect+json" \
  -d '{"name": "World"}'
```

The exact path depends on the service `typeName` from codegen (often the proto package + service name, e.g. `greet.v1.Greeter/SayHello`).

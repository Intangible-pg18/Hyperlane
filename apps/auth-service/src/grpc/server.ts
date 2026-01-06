import * as http2 from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ConnectRouter, Interceptor } from "@connectrpc/connect"; // <--- Import Interceptor type
import { createLogger } from "@hyperlane/logger";
import authHandler from "./auth.handler.js";

const logger = createLogger("auth-service-grpc");

// ----------------------------------------------------------------------
// 1. Configuration
// ----------------------------------------------------------------------
const GRPC_PORT = parseInt(process.env.GRPC_PORT || "50051", 10);

// ----------------------------------------------------------------------
// 2. Router Setup
// ----------------------------------------------------------------------
const routes = (router: ConnectRouter) => { //menu manager: collecting all the dishes from the verious chefs like Auth, Payments etc.
  // Register the handlers
  authHandler(router);
};

// ----------------------------------------------------------------------
// 3. Interceptors (Middleware)
// ----------------------------------------------------------------------
// Explicitly typed to satisfy Strict TypeScript
const loggingInterceptor: Interceptor = (next) => async (req) => {
  const start = Date.now();
  try {
    const res = await next(req);
    if (process.env.NODE_ENV === "development") {
      logger.info({
        method: req.method.name,
        service: req.service.typeName,
        duration: `${Date.now() - start}ms`
      }, "gRPC Call Success");
    }
    return res;
  } catch (err) {
    logger.error({
      method: req.method.name,
      service: req.service.typeName,
      duration: `${Date.now() - start}ms`,
      err
    }, "gRPC Call Failed");
    throw err;
  }
};

// ----------------------------------------------------------------------
// 4. Server Factory
// ----------------------------------------------------------------------
export const startGrpcServer = () => {
  // The Adapter converts ConnectRPC routes into a Node.js request handler
  const handler = connectNodeAdapter({ //takes the finished menu and waits for a request so as to pass to the correct chef
    routes,
    // HYPERSCALE: Interceptors (Middleware)
    interceptors: [loggingInterceptor]
  });

  // HYPERSCALE: Manual Session Tracking
  // Node.js http2.Server doesn't track sessions automatically in a public property.
  // We must track them to ensure we can force-close them on shutdown.
  const sessions = new Set<http2.ServerHttp2Session>();
  
  // 4. HTTP/2 Server (H2C - Cleartext)
  // We use createServer (not createSecureServer) because TLS is handled by the Mesh/LB.
  const server = http2.createServer(
    {
      // HYPERSCALE TUNING:
      // Prevent "Stream Multiplexing" attacks or memory leaks
      maxSessionMemory: 10, 
      settings: {
        maxConcurrentStreams: 1000, // Allow high concurrency from Go backend
        initialWindowSize: 65535, // Standard TCP window
      }
    },
    handler
  );
/*
This is the most common point of confusion with ConnectRPC and Modern JavaScript/TypeScript. It feels like "magic" because Setup Time logic looks very similar to Run Time logic, but they happen at completely different moments.

Here is exactly what is happening behind the scenes, broken down by Time of Execution and a visualization of the "Invisible Code" the adapter generates.

Phase 1: Setup Time (When you start the server)

When you run node index.js, the script executes from top to bottom.

startGrpcServer() is called.

Inside it, connectNodeAdapter({...}) is called.

Inside the Adapter (The "Magic"):

The adapter executes your routes function immediately.

It passes a "Router Object" into authHandler(router).

Your authHandler runs: router.service(AuthService, { validateSession: ... }).

Result: The adapter now possesses an internal "Map" or "Registry" that looks like this in memory:

code
JavaScript
download
content_copy
expand_less
// Internal Registry inside Connect
{
  "/auth.AuthService/ValidateSession": {
     implementation: async (req, ctx) => { ... }, // Your code from auth.handler.ts
     interceptors: [loggingInterceptor] // It wraps your code with the interceptor here
  }
}

Crucial Concept: The routes function and authHandler are never called again. They ran once to build the map.

The Return Value:
connectNodeAdapter returns a single function (we'll call it theBigHandler). This function is what Node.js actually uses to handle network traffic.

Phase 2: Run Time (When a user makes a request)

Now the server is running. A user sends a request to POST /auth.AuthService/ValidateSession.

Here is the Order of Execution, step-by-step:

Node.js HTTP/2 Server receives the packet.

It passes the request to theBigHandler (the thing created in Phase 1).

theBigHandler looks at the URL: /auth.AuthService/ValidateSession.

It looks up the "Map" created in Phase 1 and finds your function.

It starts the Onion Chain (Interceptors):

It does not run your validateSession yet.

It runs the loggingInterceptor first.

The "Onion" Execution Flow

Imagine loggingInterceptor wrapping around your validateSession.

code
JavaScript
download
content_copy
expand_less
// 1. Logging Interceptor Starts
const start = Date.now(); 
try {
   // 2. The "next(req)" call happens here. 
   // This hands control over to the actual business logic.
   const res = await next(req); // <--- PAUSE HERE, JUMP TO BUSINESS LOGIC

   // ---------------------------------------------------------
   // 3. Your Code (auth.handler.ts) runs:
   // async validateSession(req, ctx) { ... }
   // Returns { userId: "123" }
   // ---------------------------------------------------------

   // 4. "next(req)" returns the value from step 3. 
   // We are back inside the Interceptor!
   
   logger.info("Success", Date.now() - start); // Log success
   return res; // Pass the data back to the user

} catch (err) {
   // If Step 3 crashed, we land here
   logger.error("Failed");
   throw err;
}
Phase 3: The "Invisible Code" (What does the Adapter produce?)

If you could see the source code that connectNodeAdapter generates and hands to Node.js, it would look roughly like this pseudo-code. This helps demystify the syntax:

code
JavaScript
download
content_copy
expand_less
// This is effectively what "const handler" becomes:
const handler = async (nodeRequest, nodeResponse) => {

  // 1. Check the URL
  const url = nodeRequest.url; // e.g., "/auth.AuthService/ValidateSession"

  // 2. Find the matching implementation (registered during Setup Phase)
  const serviceDef = internalRegistry[url]; 
  
  if (!serviceDef) return nodeResponse.send404();

  // 3. Deserialize JSON/Protobuf body
  const parsedBody = await parseBody(nodeRequest);

  // 4. Construct the "Next" chain
  // This combines your Business Logic with the Interceptor
  const chain = async (req) => {
      // The interceptor runs, and we pass the ACTUAL business logic as 'next'
      return loggingInterceptor( async (finalReq) => {
           // This is your code from auth.handler.ts
           return serviceDef.validateSession(finalReq);
      })(req);
  };

  // 5. EXECUTE THE CHAIN
  try {
      const result = await chain(parsedBody);
      
      // 6. Send Response
      nodeResponse.writeHead(200);
      nodeResponse.end(JSON.stringify(result));
  } catch (error) {
      nodeResponse.writeHead(500);
      nodeResponse.end(JSON.stringify(error));
  }
};
Summary of your specific confusions:

The Adapter Syntax: It accepts routes (to build the map) and interceptors (to wrap the map entries). It compiles them into one standard function.

Order of Execution:

Interceptor (Top half: Date.now())

await next(req) -> Calls Your authHandler (validateSession)

Interceptor (Bottom half: logger.info)

Why authHandler looks like that: The syntax router.service(...) is just a configuration API. It tells the adapter: "Hey, when someone asks for ValidateSession, use this function." It doesn't run the logic then; it just stores the reference.
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Syntax:
const routes = ...: defining a variable holding an arrow function.
(router: ConnectRouter): The function accepts one argument, typed as ConnectRouter.
Depth: This function serves as the "registry." It doesn't run logic itself; instead, it passes the router object to authHandler, which will attach specific RPC methods (like Login, Register, etc.) to that router.
-------------------------------------------------------

*/
  // Track sessions
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => {
      sessions.delete(session);
    });
  });

  server.listen(GRPC_PORT, "0.0.0.0", () => {
    logger.info(`gRPC Server (HTTP/2) running on port ${GRPC_PORT}`);
  });

  // Graceful Shutdown Hook
  // Returns a function that index.ts can call to stop this server
  return async () => {
    logger.info("Stopping gRPC Server...");
    return new Promise<void>((resolve, reject) => {
      // 1. Stop accepting new connections
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      
      // 2. Force close existing sessions that are stuck
      for (const session of sessions) {
        if (!session.closed) {
          session.close();
        }
      }
      sessions.clear();
    });
  };
};
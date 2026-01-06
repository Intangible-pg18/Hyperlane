import { ConnectRouter, HandlerContext, Code, ConnectError } from "@connectrpc/connect";
import { create, toJsonString, fromJsonString } from "@bufbuild/protobuf"; 
import { AuthService, ValidateSessionResponseSchema, type ValidateSessionRequest, type ValidateSessionResponse } from "@hyperlane/contracts/dist/proto/auth/v1/auth_pb.js";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { prisma, LaneRole } from "@hyperlane/database";
import { redis } from "../lib/redis.js";
import { createLogger } from "@hyperlane/logger";
import { identityService } from "../services/identity.service.js";

const logger = createLogger("auth-service-grpc");

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  throw new Error("Fatal: CLERK_SECRET_KEY is missing in environment variables");
}

const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });

// HYPERSCALE CONFIG: Cache sessions for 60 seconds.
// Trade-off: A banned user might stay connected for 60s, but we save 99% of DB calls.
const SESSION_CACHE_TTL = 60; 

export default (router: ConnectRouter) => {
  //router.service is telling when someone asks for auth.AuthService, use THIS object to handle it.
  router.service(AuthService, { //AuthService is an interface being passed to make sure the actual object (next to it) follows this interface's contract.
    /**
     * Validates a session token and returns user context.
     * Called by: Lane Service (Node), Media Service (Go).
     */
    async validateSession(req: ValidateSessionRequest, ctx: HandlerContext): Promise<ValidateSessionResponse> { // ctx contains request's metadata like ip address, http headers etc
      const { token } = req;

      if (!token) {
        throw new ConnectError("Token is required", Code.InvalidArgument);
      }

      // 1. CACHE LAYER (Read)
      // We hash the token (or use it directly if short) to check Redis.
      // Key: "session:{token_tail_signature}"
      const cacheKey = `session:${token.slice(-32)}`; 
      const cachedResult = await redis.get(cacheKey);

      if (cachedResult)
        // v2 FIX: Deserialize JSON string back to Message using Schema
        // HIT: Return fast without touching DB or Clerk
        return fromJsonString(ValidateSessionResponseSchema, cachedResult);

      try {
        // 2. CLERK VERIFICATION (CPU Intensive)
        // This verifies the cryptographic signature of the JWT.
        const verifiedToken = await verifyToken(token, { 
          secretKey: CLERK_SECRET_KEY 
        });
        
        const clerkId = verifiedToken.sub;

        // 3. DATABASE LOOKUP (With JIT Fallback)
        let user = await prisma.user.findUnique({
          where: { clerkId },
        });

        // EDGE CASE: JIT Provisioning
        // The token is valid, but Postgres doesn't have the user yet (Webhook lag).

        if (!user) {
          logger.warn({ clerkId }, "JIT Provisioning triggered during gRPC call");
          
          // Fetch full profile from Clerk API to populate DB
          const clerkUser = await clerk.users.getUser(clerkId);
          const primaryEmail = clerkUser.emailAddresses.find(
            e => e.id === clerkUser.primaryEmailAddressId
          )?.emailAddress;

          if (!primaryEmail)
             throw new ConnectError("User has no email", Code.FailedPrecondition);

          // Sync immediately
          await identityService.syncUser({
            clerkId,
            email: primaryEmail,
            username: clerkUser.username || `user_${clerkId.slice(0,8)}`,
            avatarUrl: clerkUser.imageUrl,
            // No eventId because this is JIT, not a webhook
          });

          // Fetch again (now guaranteed to exist)
          user = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
        }

        // 4. BAN CHECK
        if (user.deletedAt)
          throw new ConnectError("User is globally suspended", Code.PermissionDenied);

        if(req.requiredScope && req.requiredScope.startsWith("lane:")) {
          const parts = req.requiredScope.split(":");
          const laneId = parts[1];
          if(laneId) {
            const membership = await prisma.laneMember.findUnique({
              where: {
                laneId_userId: {
                  laneId: laneId,
                  userId: user.id
                }
              }
            })
            if(membership?.role === LaneRole.BANNED) {
              logger.warn({userId: user.id, laneId}, "Rejected banned user from lane");
              throw new ConnectError("You are banned from this lane", Code.PermissionDenied);
            }
          }
        }

        // v2 FIX: Use create() with Schema
        // 5. CONSTRUCT RESPONSE
        const response = create(ValidateSessionResponseSchema, {
          valid: true,
          userId: user.id, // Our internal UUIDv7
          username: user.username,
          avatarUrl: user.avatarUrl || "",
          roles: [], // TODO: Implement RBAC logic here later
          extraClaims: {
            email: user.email,
            clerk_id: clerkId,
          }
        });

        // v2 FIX: Serialize to JSON string using Schema
        // 6. CACHE LAYER (Write)
        // Save the result to Redis so the next 1000 calls for this user are instant.
        // We serialize the Protobuf message to a plain object/string.
        await redis.set(
          cacheKey, 
          toJsonString(ValidateSessionResponseSchema, response), 
          "EX", 
          SESSION_CACHE_TTL
        );

        return response;

      } catch (err) {
        // Differentiate between "Invalid Token" and "Server Error"
        const errorMessage = (err as Error).message || "";
        
        if (errorMessage.includes("expired") || errorMessage.includes("invalid"))
          // v2 FIX: Create simple response
          // We return valid=false instead of throwing, so the caller knows it's not a system error
          return create(ValidateSessionResponseSchema, { valid: false });

        logger.error({ err }, "Session validation failed");
        throw new ConnectError("Internal Auth Error", Code.Internal);
      }
    },
  });
};
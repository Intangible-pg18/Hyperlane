import {prisma} from "@hyperlane/database"
import {uuidv7} from "uuidv7"
import {createLogger} from "@hyperlane/logger"
import {redis} from "../lib/redis.js"

const logger = createLogger("auth-service");



export interface SyncUserDto {
    clerkId: string;
    email: string;
    username: string;
    avatarUrl?: string | null | undefined;
    eventId?: string //used for idempotency but optional for JIT syncs
}

export class IdentityService {

    async syncUser(data: SyncUserDto) {
        const {clerkId, email, username, avatarUrl, eventId} = data;

        if (eventId) {
            const idempotencyKey = `event:processed:${eventId}`;
            const alreadyProcessed = await redis.get(idempotencyKey);
            if(alreadyProcessed) {
                logger.info({clerkId, eventId}, "Skipping duplicate webhook event")
                return
            }
        }

        try {
            //upsert to prevent race & idempotency conditions
            const user = await prisma.user.upsert({
                where: {clerkId},
                update: {
                    email,
                    username,
                    avatarUrl: avatarUrl ?? null,
                    updatedAt: new Date(),
                    deletedAt: null // resurrection logic
                },
                create: {
                    id: uuidv7(),
                    clerkId,
                    email,
                    username,
                    avatarUrl: avatarUrl ?? null
                }
            })
            
            if(eventId) {
                const idempotencyKey= `event:processed:${eventId}`;
                await redis.set(idempotencyKey, "1", "EX", 86400);
            }
            logger.info({userId: user.id, clerkId}, "Identity synced successfully to DB");
        }
        catch(error) {
            logger.error({error, clerkId}, "Failed to sync identity to DB")
            throw error;
        }
    }

    //soft delete
    async deleteUser(clerkId: string, eventId: string) {

        const idempotencyKey = `event:processed:${eventId}`;
    
        if (await redis.get(idempotencyKey)) {
        logger.info({ clerkId, eventId }, "Skipping duplicate delete event");
        return;
        }

        try {
            await prisma.user.update({
                where: {clerkId},
                data: {
                    deletedAt: new Date()
                }
            })
            await redis.set(idempotencyKey, "1", "EX", 86400);
            logger.info({clerkId}, "Identity soft-deleted");
        }
        catch(error) {
            if ((error as any).code === 'P2025') {
                await redis.set(idempotencyKey, "1", "EX", 86400);
                logger.warn({ clerkId }, "Ignored delete for non-existent user");
                return;
            }
            throw error;
        }
    }
}

//singleton export
export const identityService = new IdentityService();
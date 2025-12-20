import {Request, Response} from "express"
import {Webhook} from "svix"
import {createLogger} from "@hyperlane/logger"
import {identityService} from "../services/identity.service.js"

const logger  = createLogger("auth-service");

interface ClerkUserEvent {
    data: {
        id: string; //clerkID
        email_addresses: {email_address: string, id: string } [];
        username?: string;
        image_url?: string;
        first_name?: string;
        last_name?: string;
    };
    object: "event";
    type: "user.created" | "user.updated" | "user.deleted";
}

export const handleClerkWebhook = async (req: Request, res: Response): Promise<void> => {
    const SIGNING_SECRET = process.env.CLERK_WEBHOOK_SECRET;

    if(!SIGNING_SECRET) {
        logger.error("Missing CLERK_WEBHOOK_SECRET in environment variables");
        res.status(500).json({error: "Server configuration error"});
        return;
    }

    //verifying signature
    const svix_id = req.headers["svix-id"] as string;
    const svix_timestamp = req.headers["svix-timestamp"] as string;
    const svix_signature = req.headers["svix-signature"] as string;

    if (!svix_id || !svix_timestamp || !svix_signature) {
        res.status(400).json({ error: "Missing headers" });
        return;
    }

    if(!req.rawBody) {
        logger.error("req.rawBody is missing. Middleware misconfiguration.");
        res.status(500).json({error: "Internal server error"});
        return;
    }

    const payload = req.rawBody.toString();
    const wh = new Webhook(SIGNING_SECRET);
    let evt: ClerkUserEvent;

    try {
        evt = wh.verify(payload, {
            "svix-id": svix_id,
            "svix-timestamp": svix_timestamp,
            "svix-signature": svix_signature,
        }) as ClerkUserEvent;
    } catch(err) {
        logger.warn({err, ip: req.ip}, "Invalid webhook signature");
        res.status(400).json({error: "Invalid signature"})
        return;
    }
    
    const {type, data} = evt;
    const clerkId = data.id;

    logger.info({type, clerkId}, "Processing verified Clerk webhook");

    try {
        if(type === "user.created" || type === "user.updated") {
            const email = data.email_addresses[0]?.email_address;
            const username = data.username || `user_${clerkId.slice(0, 8)}`;

            if (!email) {
                logger.warn({ clerkId }, "User has no email address, skipping sync");
                res.status(400).json({ error: "No email provided" });
                return;
            }

            await identityService.syncUser({
                clerkId,
                email,
                username,
                avatarUrl: data.image_url,
                eventId: svix_id
            });
        }

        else if(type === "user.deleted") 
            await identityService.deleteUser(clerkId, svix_id);
        
        else 
            logger.info({type}, "Ignored unhandled event type");

        res.status(200).json({success: true});
    }
    catch (err) {
        logger.error({err, clerkId}, "Failed to process webhook business logic");
        res.status(500).json({error: "Internal server error"})
    }
}
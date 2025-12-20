import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {Pool} from "pg";

//setting up connection pool
const connectionString = `${process.env.DATABASE_URL}`;

console.log("DEBUG: Database Connection String:", connectionString);
const pool = new Pool({connectionString});

const adapter = new PrismaPg(pool);

const prismaClientSingleton = () => {
    return new PrismaClient({
        adapter,
        //logging less in production for performance
        log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    });
};

type PrismaClientSingleton = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClientSingleton | undefined;
};

export const prisma = globalForPrisma.prisma ?? prismaClientSingleton();

export * from "@prisma/client";

if(process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
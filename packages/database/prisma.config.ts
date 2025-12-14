import { defineConfig } from '@prisma/config';
import dotenv from "dotenv"

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("Fatal: DATABASE_URL is missing from environment variables.");
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
      url: process.env.DATABASE_URL
  },
});
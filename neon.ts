import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    nettleapi: {
      name: "Nettle Group API",
      source: "neon-function/index.mjs",
      env: {
        DATABASE_URL: process.env.DATABASE_URL!,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
        INITIAL_ADMIN_TELEGRAM_ID: process.env.INITIAL_ADMIN_TELEGRAM_ID!,
        SESSION_SECRET: process.env.SESSION_SECRET!,
        SITE_ORIGIN: process.env.SITE_ORIGIN!,
      },
    },
  },
});

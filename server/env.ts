import { z } from 'zod';

const schema = z.object({
  // Base URL of store-api. Required: a site with no catalogue source has a
  // permanently broken plugins page, so failing at boot beats serving one.
  STORE_API_URL: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\/+$/, '')),
  // The shared secret store-api validates. 32 chars is the point below which a
  // shared secret is guessable, matching store-api's own floor.
  INTERNAL_API_KEY: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8080),
  // In front of store-api's own 15 minute registry refresh. This one exists so
  // store-api is not called once per page view; that one exists so the registry
  // is not hammered. Neither makes the other redundant.
  CATALOG_CACHE_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Where the VitePress build output lives, relative to the working directory.
  SITE_DIST: z.string().min(1).default('./site/.vitepress/dist'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, string> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${detail}`);
  }
  return parsed.data;
}

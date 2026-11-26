import { z } from "zod";

/**
 * No `new Function` in zod's parsers: the UI's Content-Security-Policy forbids eval (#317), so
 * the attempt would only fail and log a violation. Imported first by `main.tsx`.
 */
z.config({ jitless: true });

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the Cloudflare Pages build environment.");
}

const parsedUrl = new URL(supabaseUrl);
if (parsedUrl.protocol !== "https:") {
  throw new Error("SUPABASE_URL must use HTTPS for a production deployment.");
}

const configuration = {
  supabaseUrl,
  supabasePublishableKey,
};

await writeFile(
  fileURLToPath(new URL("../dashboard/config.js", import.meta.url)),
  `window.PCMA_CONFIG = Object.freeze(${JSON.stringify(configuration)});\n`,
  "utf8",
);

console.log("Generated dashboard/config.js for the Cloudflare Pages build.");

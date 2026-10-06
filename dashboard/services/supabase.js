import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.PCMA_CONFIG;
export const configurationError = !config?.supabaseUrl || !config?.supabasePublishableKey ||
  config.supabaseUrl.includes("YOUR_PROJECT_ID") || config.supabasePublishableKey.includes("YOUR_SUPABASE_");

export const supabase = configurationError
  ? null
  : createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 5 } },
    });

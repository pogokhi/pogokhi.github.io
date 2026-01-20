/**
 * Supabase Client Wrapper
 */
window.SupabaseClient = {
    supabase: null,

    init: async function () {
        // [SECURE] Read from window.SUPABASE_CONFIG (loaded from js/config.js)
        const config = window.SUPABASE_CONFIG || {};
        const SUPABASE_URL = config.SUPABASE_URL || "YOUR_SUPABASE_URL";
        const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY || "YOUR_SUPABASE_KEY";

        if (SUPABASE_URL === "YOUR_SUPABASE_URL") {
            console.warn("⚠️ Supabase URL/Key not configured.");
            return;
        }

        this.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                storage: sessionStorage,
            },
        });
        console.log("🔌 Supabase Client Initialized");
    }
};

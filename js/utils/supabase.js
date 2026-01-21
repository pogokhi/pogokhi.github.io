/**
 * Supabase Client Wrapper
 */
window.SupabaseClient = {
    supabase: null,

    init: async function () {
        // [SECURE] Read from window.SUPABASE_CONFIG (loaded from js/config.js)
        const config = window.SUPABASE_CONFIG || {};
        const SUPABASE_URL = config.SUPABASE_URL;
        const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY;

        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
            console.error("❌ Supabase URL/Key missing. Please check js/config.js");
            return false;
        }

        try {
            this.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: {
                    storage: sessionStorage,
                },
            });
            console.log("🔌 Supabase Client Initialized");
            return true;
        } catch (error) {
            console.error("❌ Failed to create Supabase client:", error);
            return false;
        }
    }
};

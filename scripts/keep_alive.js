/**
 * Supabase DB Activity Keep-Alive Script
 * Prevents Supabase Free Tier projects from pausing after 7 days of inactivity.
 */

const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/+$/, '') : '';
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required.');
  console.error('Please configure GitHub Repository Secrets for SUPABASE_URL and SUPABASE_ANON_KEY.');
  process.exit(1);
}

async function pingSupabase() {
  console.log('🔄 Initiating Supabase DB Keep-Alive Ping...');
  console.log(`📌 Target URL: ${supabaseUrl}`);

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'GitHub-Actions-Keep-Alive/1.0'
  };

  let successCount = 0;

  // 1. Root PostgREST OpenAPI Spec Request (Always triggers DB schema query & PostgREST engine activity)
  try {
    const startTime = Date.now();
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'GET',
      headers: headers
    });
    const duration = Date.now() - startTime;

    if (response.ok || response.status === 200) {
      console.log(`✅ [1/2] Root REST API Ping successful! (Status: ${response.status}, Time: ${duration}ms)`);
      successCount++;
    } else {
      console.warn(`⚠️ [1/2] Root REST API returned status ${response.status}`);
    }
  } catch (err) {
    console.error(`❌ [1/2] Root REST API request failed:`, err.message);
  }

  // 2. Table query ping (Backup ping)
  try {
    const startTime = Date.now();
    const response = await fetch(`${supabaseUrl}/rest/v1/basic_schedules?select=count&limit=1`, {
      method: 'GET',
      headers: headers
    });
    const duration = Date.now() - startTime;

    if (response.ok) {
      console.log(`✅ [2/2] Table query ping successful! (Status: ${response.status}, Time: ${duration}ms)`);
      successCount++;
    } else {
      // Even if table doesn't exist (404) or RLS limits access (401/403), the request reached PostgREST & DB engine.
      console.log(`ℹ️ [2/2] Table query ping reached Supabase engine (Status: ${response.status}, Time: ${duration}ms)`);
      if (response.status < 500) {
        successCount++; // Reaching engine is enough to register activity
      }
    }
  } catch (err) {
    console.error(`❌ [2/2] Table query ping failed:`, err.message);
  }

  if (successCount > 0) {
    console.log('🎉 Supabase Keep-Alive finished successfully. Database activity registered!');
    process.exit(0);
  } else {
    console.error('💥 All pings failed. Please verify SUPABASE_URL and SUPABASE_ANON_KEY secrets.');
    process.exit(1);
  }
}

pingSupabase();

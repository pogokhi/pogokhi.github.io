// Config from Environment Variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY are required.');
  process.exit(1);
}

// Initialize Supabase Client (No external dependency needed if using fetch directly, 
// to keep it lightweight and dependency-free in CI, we use standard FETCH.)

async function pingSupabase() {
  console.log('Pinging Supabase to keep it alive...');

  try {
    // Check if fetch is available (Node.js 18+)
    if (typeof fetch === 'undefined') {
      throw new Error('fetch is not defined. Please use Node.js 18 or later.');
    }

    // Simple REST query to a public table (e.g. basic_schedules)
    // Limits to 1 row to minimize data transfer.
    const response = await fetch(`${supabaseUrl}/rest/v1/basic_schedules?select=count&limit=1`, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Success! Supabase is active.', data);
  } catch (error) {
    console.error('Error pinging Supabase:', error.message || error);
    process.exit(1);
  }
}

pingSupabase();

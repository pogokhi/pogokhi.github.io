const apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkcXRoZXJld3Rhb2RmdWFsaWdmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgwOTQ0ODcsImV4cCI6MjA4MzY3MDQ4N30.qBVKMrZWNvEcAQL2ZGADHIPS0zB8n71OxAdzqWgnzy8";
fetch("https://tdqtherewtaodfualigf.supabase.co/rest/v1/schedules?select=*&limit=1", {
  headers: {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`
  }
}).then(res => res.json()).then(console.log);

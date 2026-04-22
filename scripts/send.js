const LINE_TOKEN = process.env.LINE_TOKEN;
const COMMIT_SHA = process.env.COMMIT_SHA;
const REPO = process.env.GITHUB_REPOSITORY;

if (!LINE_TOKEN) {
  console.error('Missing LINE_TOKEN env');
  process.exit(1);
}
if (!COMMIT_SHA) {
  console.error('Missing COMMIT_SHA env');
  process.exit(1);
}
if (!REPO) {
  console.error('Missing GITHUB_REPOSITORY env');
  process.exit(1);
}

const baseUrl = `https://raw.githubusercontent.com/${REPO}/${COMMIT_SHA}/output`;
const originalUrl = `${baseUrl}/latest.png`;
const previewUrl = `${baseUrl}/latest-preview.jpg`;

console.log('Sending broadcast to LINE:');
console.log('  Original:', originalUrl);
console.log('  Preview:', previewUrl);

const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${LINE_TOKEN}`,
  },
  body: JSON.stringify({
    messages: [
      {
        type: 'image',
        originalContentUrl: originalUrl,
        previewImageUrl: previewUrl,
      },
    ],
  }),
});

if (!res.ok) {
  const text = await res.text();
  console.error('LINE API error:', res.status, text);
  process.exit(1);
}

console.log('✓ Broadcast sent successfully');

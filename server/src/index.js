import { createApp } from './app.js';
import { connectDB } from './config/db.js';

const PORT = process.env.PORT || 5000;

try {
  await connectDB();
  console.log('✓ Connected to MongoDB');

  createApp().listen(PORT, () => {
    console.log(`✓ API listening on http://localhost:${PORT}`);
  });
} catch (err) {
  console.error('\n✗ Could not start the server:\n');
  console.error(err.message);
  console.error('\nCheck server/.env against server/.env.example.\n');
  process.exit(1);
}

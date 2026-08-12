import mongoose from 'mongoose';

export async function connectDB(uri = process.env.MONGODB_URI) {
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set.\n' +
        'Copy server/.env.example to server/.env and paste your MongoDB Atlas connection string.',
    );
  }
  if (uri.includes('<user>') || uri.includes('<password>')) {
    throw new Error(
      'MONGODB_URI still contains the placeholder <user>/<password> from .env.example.\n' +
        'Replace them with your real Atlas database credentials.',
    );
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  return mongoose.connection;
}

export function disconnectDB() {
  return mongoose.disconnect();
}

import express from 'express';
import { join } from 'node:path';
import { root, avatarDir } from './db.js';
import { loadUser, ensureAdmin } from './auth.js';
import { startTracker } from './tracker.js';
import { bad } from './http.js';
import account from './routes/account.js';
import watches from './routes/watches.js';
import chat from './routes/chat.js';
import admin from './routes/admin.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

ensureAdmin();

// On a host like Hostinger the app sits behind a proxy; trust it so each visitor's real IP is used
// (otherwise the login rate limit would treat all visitors as one person).
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' })); // room for a resized profile picture
app.use(loadUser);
app.use(express.static(join(root, 'public')));
app.use('/avatars', express.static(avatarDir, { maxAge: '30d', immutable: true }));

app.use('/api', account, watches, chat, admin);
app.use('/api', (_req, res) => bad(res, 'Not found', 404));

app.listen(PORT, () => {
  console.log(`Seaplane Watch running at http://localhost:${PORT}  (push notifications on)`);
  if (process.env.TRACKING !== 'off') startTracker();
});

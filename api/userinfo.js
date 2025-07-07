import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

export default function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, id: payload.id, username: payload.username, email: payload.email });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}
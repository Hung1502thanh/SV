const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'tributes.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS tribute_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tributes (
    visitor_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO tribute_counter (id, count) VALUES (1, 0);
`);

const addTribute = db.prepare(`
  INSERT OR IGNORE INTO tributes (visitor_id) VALUES (?)
`);
const hasTribute = db.prepare(`
  SELECT 1 FROM tributes WHERE visitor_id = ?
`);
const incrementCount = db.prepare(`
  UPDATE tribute_counter SET count = count + 1 WHERE id = 1
`);
const getCount = db.prepare(`
  SELECT count FROM tribute_counter WHERE id = 1
`);

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

function getVisitorId(request) {
  const cookies = request.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)tribute_visitor=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function servePage(response) {
  fs.readFile(path.join(ROOT, 'head.html'), (error, html) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to load the memorial page.');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(html);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
    servePage(response);
    return;
  }

  if (url.pathname === '/api/tributes') {
    if (request.method === 'GET') {
      const visitorId = getVisitorId(request);
      const count = getCount.get().count;
      const recorded = visitorId ? Boolean(hasTribute.get(visitorId)) : false;

      sendJson(response, 200, { count, recorded });
      return;
    }

    if (request.method === 'POST') {
      let visitorId = getVisitorId(request);
      const isNewVisitor = !visitorId;

      if (isNewVisitor) {
        visitorId = crypto.randomUUID();
      }

      try {
        const alreadyRecorded = Boolean(hasTribute.get(visitorId));

        if (!alreadyRecorded) {
          db.exec('BEGIN');
          try {
            const result = addTribute.run(visitorId);
            if (result.changes === 1) {
              incrementCount.run();
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }

        const count = getCount.get().count;
        const recorded = Boolean(hasTribute.get(visitorId));
        const headers = isNewVisitor
          ? {
              'Set-Cookie': `tribute_visitor=${encodeURIComponent(visitorId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000`
            }
          : {};

        sendJson(response, 200, { count, recorded }, headers);
        return;
      } catch (error) {
        console.error('Failed to record tribute:', error);
        sendJson(response, 500, { error: 'Unable to record tribute' });
        return;
      }
    }
  }

  response.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`H SMP memorial running at http://localhost:${PORT}`);
});

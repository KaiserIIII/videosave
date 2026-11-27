import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settingsFile } from './preferences.mjs';

const historyLimit = 100;
const active = new Set(['running','interrupted','cancelling']);

export const pendingItem = item => !['done','error','cancelled'].includes(item.status);

export function completedStatus(items) {
  const failed = items.filter(item => item.status === 'error').length;
  return failed === 0 ? 'done' : failed === items.length ? 'failed' : 'partial';
}

function withDatabase(run) {
  if (!existsSync(settingsFile)) mkdirSync(path.dirname(settingsFile), {recursive:true,mode:0o700});
  const connection = new DatabaseSync(settingsFile, {timeout:5000});
  try {
    connection.exec(`CREATE TABLE IF NOT EXISTS download_batches (
      id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, owner INTEGER NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS download_batch_request ON download_batches(request_hash, status);`);
    return run(connection);
  } finally {
    connection.close();
  }
}

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function restore(row) {
  if (!row) return;
  const batch = JSON.parse(row.data);
  if (batch.status === 'interrupted' || batch.status === 'running' && !ownerAlive(row.owner)) {
    batch.status = 'interrupted';
  } else if (batch.status === 'cancelling' && !ownerAlive(row.owner)) {
    batch.status = 'cancelled';
    for (const item of batch.items) {
      if (pendingItem(item)) item.status = 'cancelled';
    }
  }
  if (batch.status === 'interrupted' && !batch.items.some(pendingItem)) batch.status = completedStatus(batch.items);
  return batch;
}

function transaction(run) {
  return withDatabase(connection => {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const result = run(connection);
      connection.exec('COMMIT');
      return result;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  });
}

export function storedBatch(id) {
  if (!existsSync(settingsFile)) return;
  return withDatabase(connection => restore(connection.prepare('SELECT owner,data FROM download_batches WHERE id=?').get(id)));
}

export function storedBatches() {
  if (!existsSync(settingsFile)) return [];
  return withDatabase(connection => connection.prepare('SELECT owner,data FROM download_batches ORDER BY created_at, rowid').all().map(restore));
}

export function storeBatch(batch) {
  withDatabase(connection => {
    connection.prepare(`UPDATE download_batches SET status=?, data=? WHERE id=? AND owner=?`)
      .run(batch.status,JSON.stringify(batch),batch.id,process.pid);
    if (!active.has(batch.status)) {
      connection.prepare(`DELETE FROM download_batches WHERE id IN (
        SELECT id FROM download_batches WHERE status NOT IN ('running','interrupted','cancelling')
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(historyLimit);
    }
  });
}

export function claimBatch(hash, create, reuseCompleted) {
  return transaction(connection => {
    const rows = connection.prepare(`SELECT owner,data FROM download_batches WHERE request_hash=?
      AND status IN ('running','interrupted') ORDER BY rowid DESC`).all(hash);
    const matching = rows.map(restore);
    const existing = matching.find(batch => batch.status === 'running');
    if (existing) return {batch:existing,claimed:false};
    const interrupted = matching.find(row => row.status === 'interrupted');
    if (!interrupted && reuseCompleted) {
      const saved = connection.prepare("SELECT data FROM download_batches WHERE request_hash=? AND status='done' ORDER BY rowid DESC LIMIT 1").get(hash);
      const completed = saved && JSON.parse(saved.data);
      if (completed && reuseCompleted(completed)) return {batch:completed,claimed:false,alreadySaved:true};
    }
    const batch = create(interrupted);
    connection.prepare(`INSERT INTO download_batches (id,request_hash,owner,status,created_at,data)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,status=excluded.status,data=excluded.data`)
      .run(batch.id,hash,process.pid,batch.status,batch.createdAt,JSON.stringify(batch));
    return {batch,claimed:true};
  });
}

export function claimInterruptedCancellation(id) {
  return transaction(connection => {
    const batch = restore(connection.prepare('SELECT owner,data FROM download_batches WHERE id=?').get(id));
    if (batch?.status !== 'interrupted') return null;
    batch.status = 'cancelling';
    connection.prepare('UPDATE download_batches SET owner=?,status=?,data=? WHERE id=?')
      .run(process.pid,batch.status,JSON.stringify(batch),id);
    return batch;
  });
}

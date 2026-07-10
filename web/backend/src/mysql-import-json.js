import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataFile = path.join(__dirname, '..', 'data', 'db.json');

try {
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const mysqlStore = await import('./mysql-store.js');
  await mysqlStore.syncMysqlState(db, { force: true });
  const status = mysqlStore.getMysqlStatus();
  console.log('db.json 已作为完整快照同步到 MySQL 镜像。', {
    connected: status.connected,
    ok: status.ok,
    counts: status.counts,
    lastSyncedAt: status.lastSyncedAt
  });
} catch (error) {
  console.error('同步 MySQL 镜像失败，db.json 未修改：', String(error?.message || error));
  process.exitCode = 1;
}

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
  await mysqlStore.initMysqlState(db);
  const status = mysqlStore.getMysqlStatus();
  console.log('MySQL 镜像表已完成幂等初始化。', {
    connected: status.connected,
    ok: status.ok,
    database: status.database,
    migration: status.migration,
    lastSyncedAt: status.lastSyncedAt
  });
} catch (error) {
  console.error('MySQL 镜像初始化失败，db.json 未修改：', String(error?.message || error));
  process.exitCode = 1;
}

import 'dotenv/config';
import mysql from 'mysql2/promise';

let connection;

function env(name, fallbackName, fallback = '') {
  return process.env[name] || process.env[fallbackName] || fallback;
}

try {
  connection = await mysql.createConnection({
    host: env('MYSQL_HOST', 'DB_HOST', '127.0.0.1'),
    port: Number(env('MYSQL_PORT', 'DB_PORT', '3306')),
    user: env('MYSQL_USER', 'DB_USER', 'root'),
    password: env('MYSQL_PASSWORD', 'DB_PASSWORD'),
    database: env('MYSQL_DATABASE', 'DB_NAME', 'xiaode_course_table')
  });

  const [rows] = await connection.query(`
    SELECT
      DATABASE() AS databaseName,
      VERSION() AS mysqlVersion,
      NOW() AS serverTime
  `);

  console.log('MySQL 连接成功：');
  console.table(rows);
} catch (error) {
  console.error('MySQL 连接失败：', error.message);
  process.exitCode = 1;
} finally {
  if (connection) {
    await connection.end();
  }
}

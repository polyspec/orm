// Opens the mysql URI of the dbspec testers as a mysql2 connection. The user and the password of the URI are decoded.
import mysql from 'mysql2/promise';

/** connectMysql opens a mysql connection to the URL, which the caller has checked for the mysql protocol and no query. */
export function connectMysql(url: URL): Promise<mysql.Connection> {
  return mysql.createConnection({
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
  });
}

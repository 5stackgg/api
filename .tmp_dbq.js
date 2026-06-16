const { Client } = require("pg");
const CONN = "postgresql://hasura:hasura@127.0.0.1:63459/hasura";
(async () => {
  const c = new Client({ connectionString: CONN, statement_timeout: 120000 });
  await c.connect();
  try { const r = await c.query(process.argv[2]); console.log(JSON.stringify(r.rows, null, 2)); }
  finally { await c.end(); }
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });

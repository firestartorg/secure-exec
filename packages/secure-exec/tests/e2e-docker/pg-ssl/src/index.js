const { Client } = require("pg");

async function main() {
	const client = new Client({
		host: process.env.PG_HOST,
		port: Number(process.env.PG_PORT),
		user: "testuser",
		password: "testpass",
		database: "testdb",
		ssl: { rejectUnauthorized: false },
	});

	await client.connect();

	// Verify connection is SSL-encrypted via pg_stat_ssl
	const sslRes = await client.query(
		"SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
	);
	const sslInfo = sslRes.rows[0];
	console.log(
		JSON.stringify({
			ssl: sslInfo.ssl,
			hasTlsVersion: typeof sslInfo.version === "string" && sslInfo.version.length > 0,
		}),
	);

	// Run a basic query to verify the SSL connection works for real data
	await client.query(
		"CREATE TABLE IF NOT EXISTS test_ssl (id SERIAL PRIMARY KEY, value TEXT)",
	);
	await client.query("INSERT INTO test_ssl (value) VALUES ($1)", [
		"ssl-test",
	]);
	const selectRes = await client.query(
		"SELECT value FROM test_ssl WHERE value = $1",
		["ssl-test"],
	);
	console.log(JSON.stringify({ rowCount: selectRes.rowCount, value: selectRes.rows[0].value }));

	// Cleanup
	await client.query("DROP TABLE IF EXISTS test_ssl");
	await client.end();
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});

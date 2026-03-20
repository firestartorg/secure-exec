const { Client } = require("pg");

async function main() {
	const results = {};

	// Test 1: Syntax error (bad SQL)
	{
		const client = new Client({
			host: process.env.PG_HOST,
			port: Number(process.env.PG_PORT),
			user: "testuser",
			password: "testpass",
			database: "testdb",
		});
		await client.connect();
		try {
			await client.query("SELECT * FORM nonexistent");
		} catch (err) {
			results.syntaxError = {
				message: err.message,
				code: err.code,
				severity: err.severity,
			};
		}
		await client.end();
	}

	// Test 2: Query nonexistent table
	{
		const client = new Client({
			host: process.env.PG_HOST,
			port: Number(process.env.PG_PORT),
			user: "testuser",
			password: "testpass",
			database: "testdb",
		});
		await client.connect();
		try {
			await client.query("SELECT * FROM nonexistent_table_xyz_12345");
		} catch (err) {
			results.undefinedTable = {
				message: err.message,
				code: err.code,
				severity: err.severity,
			};
		}
		await client.end();
	}

	// Test 3: Unique constraint violation
	{
		const client = new Client({
			host: process.env.PG_HOST,
			port: Number(process.env.PG_PORT),
			user: "testuser",
			password: "testpass",
			database: "testdb",
		});
		await client.connect();
		await client.query(
			"CREATE TABLE IF NOT EXISTS test_unique_err (id INTEGER PRIMARY KEY, value TEXT)",
		);
		await client.query("DELETE FROM test_unique_err");
		await client.query("INSERT INTO test_unique_err (id, value) VALUES (1, 'first')");
		try {
			await client.query("INSERT INTO test_unique_err (id, value) VALUES (1, 'duplicate')");
		} catch (err) {
			results.uniqueViolation = {
				message: err.message,
				code: err.code,
				severity: err.severity,
				constraint: err.constraint,
			};
		}
		await client.query("DROP TABLE test_unique_err");
		await client.end();
	}

	// Test 4: Connection to wrong port (connection refused)
	{
		const client = new Client({
			host: process.env.PG_HOST,
			port: 1,
			user: "testuser",
			password: "testpass",
			database: "testdb",
			connectionTimeoutMillis: 5000,
		});
		try {
			await client.connect();
			await client.end();
		} catch (err) {
			// Only serialize message — socket-level err.code/err.errno
			// are not propagated through the sandbox net bridge
			results.connectionRefused = {
				message: err.message,
			};
		}
	}

	console.log(JSON.stringify(results));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});

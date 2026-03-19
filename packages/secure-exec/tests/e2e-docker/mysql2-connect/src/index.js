// Eagerly initialize iconv-lite encodings to avoid lazy module loading
// during TCP data callbacks (required for both mysql2 and other packages
// that use iconv-lite for character set handling)
var iconv = require("iconv-lite");
iconv.getDecoder("utf8");

var mysql = require("mysql2/promise");

async function main() {
	var conn = await mysql.createConnection({
		host: process.env.MYSQL_HOST,
		port: Number(process.env.MYSQL_PORT),
		user: "testuser",
		password: "testpass",
		database: "testdb",
	});

	await conn.execute(
		"CREATE TABLE IF NOT EXISTS test_e2e (id INT AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255))",
	);
	await conn.execute("INSERT INTO test_e2e (value) VALUES (?)", [
		"hello-sandbox",
	]);
	var [rows] = await conn.execute(
		"SELECT value FROM test_e2e WHERE value = ?",
		["hello-sandbox"],
	);
	await conn.execute("DROP TABLE test_e2e");
	await conn.end();

	console.log(
		JSON.stringify({
			connected: true,
			rowCount: rows.length,
			value: rows[0].value,
		}),
	);
}

main().catch(function (err) {
	console.error(err.message);
	process.exit(1);
});

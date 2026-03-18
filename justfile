dev-shell:
	npx tsx scripts/shell.ts

dev-docs:
	cd docs && npx mintlify dev

dev-website:
	pnpm --filter @secure-exec/website dev

build-website:
	pnpm --filter @secure-exec/website build


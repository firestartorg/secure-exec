WASM_TARGET := wasm32-wasip1
RELEASE_DIR := target/$(WASM_TARGET)/release
WASM_OUTPUT := $(RELEASE_DIR)/multicall.wasm
WASM_OPT_OUTPUT := $(RELEASE_DIR)/multicall.opt.wasm

# Detect patched std: if patches/ has .patch files and patch-std.sh exists, use patched sysroot
PATCHES := $(wildcard patches/*.patch)
PATCH_SCRIPT := scripts/patch-std.sh

# Resolve WASI sysroot for CRT/libc needed by -Z build-std linking
# Uses rustc without +toolchain override so rust-toolchain.toml is respected
WASI_SYSROOT_SELF_CONTAINED := $(shell rustc --print sysroot)/lib/rustlib/$(WASM_TARGET)/lib/self-contained

.PHONY: all wasm wasm-opt wasm-opt-check host test clean patch-std patch-check vendor patch-vendor vendor-patch-check size-report

all: wasm host

# Apply std patches if they exist
patch-std:
ifneq ($(PATCHES),)
	@if [ -x "$(PATCH_SCRIPT)" ]; then \
		echo "Applying std patches..."; \
		./$(PATCH_SCRIPT); \
	else \
		echo "Warning: patches found but $(PATCH_SCRIPT) not executable or missing"; \
	fi
else
	@echo "No patches found, using stock std"
endif

# Resolve Rust std source for vendoring build-std deps
RUST_STD_SRC := $(shell rustc --print sysroot)/lib/rustlib/src/rust

# Vendor dependencies from crates.io into vendor/ (includes std deps for -Z build-std)
vendor:
	@if [ ! -d vendor ]; then \
		echo "Vendoring dependencies (including std library deps)..."; \
		cargo vendor \
			--sync "$(RUST_STD_SRC)/library/std/Cargo.toml" \
			--sync "$(RUST_STD_SRC)/library/test/Cargo.toml"; \
	else \
		echo "vendor/ exists — skipping (run 'make clean-vendor' to re-vendor)"; \
	fi

# Apply crate-level patches to vendored sources
patch-vendor: vendor
	@if [ -x scripts/patch-vendor.sh ]; then \
		./scripts/patch-vendor.sh; \
	else \
		echo "Warning: scripts/patch-vendor.sh not found or not executable"; \
	fi

# Dry-run verification of crate patches
vendor-patch-check: vendor
	@if [ -x scripts/patch-vendor.sh ]; then \
		./scripts/patch-vendor.sh --check; \
	else \
		echo "Warning: scripts/patch-vendor.sh not found or not executable"; \
	fi

# Ensure wasm-opt is installed (needed for post-build optimization)
wasm-opt-check:
	@if ! command -v wasm-opt >/dev/null 2>&1; then \
		echo "wasm-opt not found — installing via cargo..."; \
		cargo install wasm-opt; \
	else \
		echo "wasm-opt found: $$(wasm-opt --version)"; \
	fi

wasm: vendor patch-vendor patch-std wasm-opt-check
	RUSTFLAGS="-C link-arg=-L$(WASI_SYSROOT_SELF_CONTAINED)" \
	cargo build --target $(WASM_TARGET) \
		-Z build-std=std,panic_abort \
		--release
	@BEFORE_SIZE=$$(stat -c%s "$(WASM_OUTPUT)"); \
	BEFORE_HUMAN=$$(ls -lh "$(WASM_OUTPUT)" | awk '{print $$5}'); \
	echo ""; \
	echo "=== WASM Binary Size Report ==="; \
	echo "Before wasm-opt: $$BEFORE_HUMAN ($$BEFORE_SIZE bytes)"; \
	if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt -O3 --strip-debug "$(WASM_OUTPUT)" -o "$(WASM_OPT_OUTPUT)"; \
		AFTER_SIZE=$$(stat -c%s "$(WASM_OPT_OUTPUT)"); \
		AFTER_HUMAN=$$(ls -lh "$(WASM_OPT_OUTPUT)" | awk '{print $$5}'); \
		SAVINGS=$$((BEFORE_SIZE - AFTER_SIZE)); \
		if [ $$BEFORE_SIZE -gt 0 ]; then \
			PCT=$$((SAVINGS * 100 / BEFORE_SIZE)); \
		else \
			PCT=0; \
		fi; \
		echo "After wasm-opt:  $$AFTER_HUMAN ($$AFTER_SIZE bytes)"; \
		echo "Savings:         $$SAVINGS bytes ($$PCT%)"; \
		FINAL_SIZE=$$AFTER_SIZE; \
		FINAL_FILE="$(WASM_OPT_OUTPUT)"; \
	else \
		echo "wasm-opt not found — skipping optimization (install: cargo install wasm-opt)"; \
		FINAL_SIZE=$$BEFORE_SIZE; \
		FINAL_FILE="$(WASM_OUTPUT)"; \
	fi; \
	echo ""; \
	LIMIT=$$((25 * 1024 * 1024)); \
	if [ $$FINAL_SIZE -gt $$LIMIT ]; then \
		echo "WARNING: Binary exceeds 25MB target! Run 'make size-report' to identify top contributors."; \
	else \
		echo "OK: Binary is under 25MB target."; \
	fi; \
	echo "=== Build complete: $$FINAL_FILE ==="

# Standalone wasm-opt pass (for re-optimizing without rebuild)
wasm-opt:
	@if [ ! -f "$(WASM_OUTPUT)" ]; then \
		echo "Error: $(WASM_OUTPUT) not found. Run 'make wasm' first."; \
		exit 1; \
	fi
	@if command -v wasm-opt >/dev/null 2>&1; then \
		BEFORE=$$(ls -lh "$(WASM_OUTPUT)" | awk '{print $$5}'); \
		echo "Running wasm-opt -O3 --strip-debug..."; \
		wasm-opt -O3 --strip-debug "$(WASM_OUTPUT)" -o "$(WASM_OPT_OUTPUT)"; \
		AFTER=$$(ls -lh "$(WASM_OPT_OUTPUT)" | awk '{print $$5}'); \
		echo "Before: $$BEFORE  After: $$AFTER"; \
	else \
		echo "wasm-opt not found (install: cargo install wasm-opt)"; \
	fi

# Show per-crate size contribution (approximation from rlib sizes)
size-report:
	@if [ ! -f "$(WASM_OUTPUT)" ]; then \
		echo "Error: $(WASM_OUTPUT) not found. Run 'make wasm' first."; \
		exit 1; \
	fi
	@echo "=== WASM Binary Size Report ==="
	@echo ""
	@WASM_SIZE=$$(ls -lh "$(WASM_OUTPUT)" | awk '{print $$5}'); \
	WASM_BYTES=$$(stat -c%s "$(WASM_OUTPUT)"); \
	echo "Final binary: $$WASM_SIZE ($$WASM_BYTES bytes)  $(WASM_OUTPUT)"; \
	if [ -f "$(WASM_OPT_OUTPUT)" ]; then \
		OPT_SIZE=$$(ls -lh "$(WASM_OPT_OUTPUT)" | awk '{print $$5}'); \
		OPT_BYTES=$$(stat -c%s "$(WASM_OPT_OUTPUT)"); \
		echo "Optimized:    $$OPT_SIZE ($$OPT_BYTES bytes)  $(WASM_OPT_OUTPUT)"; \
	fi; \
	LIMIT=$$((25 * 1024 * 1024)); \
	if [ $$WASM_BYTES -gt $$LIMIT ]; then \
		echo "STATUS: OVER 25MB target!"; \
	else \
		echo "STATUS: Under 25MB target"; \
	fi
	@echo ""
	@echo "=== Per-Crate Size Contribution (rlib, top 30) ==="
	@echo "Note: rlib sizes are pre-LTO; actual contribution after LTO/DCE may differ."
	@echo ""
	@printf "%-10s  %s\n" "SIZE" "CRATE"
	@printf "%-10s  %s\n" "----" "-----"
	@ls -lhS $(RELEASE_DIR)/deps/*.rlib 2>/dev/null | \
		awk '{split($$NF, a, "/"); name=a[length(a)]; gsub(/^lib/, "", name); gsub(/-[0-9a-f]+\.rlib$$/, "", name); printf "%-10s  %s\n", $$5, name}' | \
		awk '!seen[$$2]++' | \
		head -30
	@echo ""
	@echo "=== Dependency Count ==="
	@TOTAL=$$(ls $(RELEASE_DIR)/deps/*.rlib 2>/dev/null | \
		sed 's/.*\/lib//' | sed 's/-[0-9a-f]*\.rlib//' | sort -u | wc -l); \
	echo "Unique crates: $$TOTAL"

host:
	@if [ -f host/package.json ]; then \
		echo "Building JS host runtime..."; \
		cd host && npm run build; \
	else \
		echo "Error: host/package.json not found"; \
		exit 1; \
	fi

test:
	cargo test --workspace
	@if [ -f host/package.json ]; then \
		cd host && npm test; \
	fi

clean:
	cargo clean
	rm -rf host/dist

clean-vendor:
	rm -rf vendor

patch-check:
ifneq ($(PATCHES),)
	@if [ -x "$(PATCH_SCRIPT)" ]; then \
		./$(PATCH_SCRIPT) --check; \
	else \
		echo "Warning: $(PATCH_SCRIPT) not found or not executable"; \
	fi
else
	@echo "No patches found"
endif

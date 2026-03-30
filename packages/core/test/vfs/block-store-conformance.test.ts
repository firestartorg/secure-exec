import { defineBlockStoreTests } from "../../src/test/block-store-conformance.js";
import { InMemoryBlockStore } from "../../src/vfs/memory-block-store.js";

defineBlockStoreTests({
	name: "InMemoryBlockStore",
	createStore: () => new InMemoryBlockStore(),
	capabilities: {
		copy: true,
	},
});

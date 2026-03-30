import { defineMetadataStoreTests } from "../../src/test/metadata-store-conformance.js";
import { InMemoryMetadataStore } from "../../src/vfs/memory-metadata.js";

defineMetadataStoreTests({
	name: "InMemoryMetadataStore",
	createStore: () => new InMemoryMetadataStore(),
	capabilities: {
		versioning: false,
	},
});

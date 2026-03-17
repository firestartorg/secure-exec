/**
 * Codemod Example — run untrusted code transformations safely inside secure-exec.
 *
 * Demonstrates the primary use case: reading source code from the host, executing
 * a codemod script inside a sandboxed V8 isolate (no host filesystem access), and
 * reading the transformed result back through the shared VFS.
 */
import {
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeRuntime,
  allowAllFs,
} from "secure-exec";

// Sample source file to transform — intentionally messy so the codemod has work to do.
const INPUT_SOURCE = `\
var express = require('express');
var app = express();
var PORT = 3000;

app.get('/', function(req, res) {
  var message = 'Hello World';
  res.send(message);
});

app.get('/users', function(req, res) {
  var users = ['alice', 'bob', 'charlie'];
  var filtered = users.filter(function(u) {
    return u.length > 3;
  });
  res.json(filtered);
});

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
`;

// Codemod script executed inside the sandbox. It reads the source file from VFS,
// applies transformations using only built-in string/regex operations (no external
// dependencies), and writes the result back to VFS.
const CODEMOD_SCRIPT = String.raw`
const fs = require('fs');
const path = '/app/src/server.js';

// Read source from VFS
const source = fs.readFileSync(path, 'utf8');
const lines = source.split('\n');
const output = [];

// Track which vars are reassigned so we pick const vs let correctly.
const varNames = [];
const reassigned = new Set();

// First pass: find all var declarations and assignments.
for (const line of lines) {
  const varMatch = line.match(/^\s*var\s+(\w+)\s*=/);
  if (varMatch) varNames.push(varMatch[1]);
  // Look for reassignment (name = ... without var/const/let prefix).
  const assignMatch = line.match(/^\s*(\w+)\s*=[^=]/);
  if (assignMatch && !line.match(/^\s*(var|let|const)\s/)) {
    reassigned.add(assignMatch[1]);
  }
}

// Second pass: apply transformations.
for (let i = 0; i < lines.length; i++) {
  let line = lines[i];

  // 1. Replace var with const/let.
  const varDeclMatch = line.match(/^(\s*)var\s+(\w+)(\s*=)/);
  if (varDeclMatch) {
    const [, indent, name, eq] = varDeclMatch;
    const keyword = reassigned.has(name) ? 'let' : 'const';
    line = line.replace(/^(\s*)var\s+/, indent + keyword + ' ');
  }

  // 2. Convert function(args) callbacks to arrow functions.
  line = line.replace(
    /function\s*\(([^)]*)\)\s*\{/g,
    '($1) => {'
  );

  // 3. Convert string concatenation to template literals.
  // Simple case: 'str' + VAR patterns.
  const BT = String.fromCharCode(96); // backtick
  const concatMatch = line.match(/^(\s*.+)'([^']+)'\s*\+\s*(\w+)\s*$/);
  if (concatMatch) {
    const [, prefix, str, varName] = concatMatch;
    line = prefix + BT + str + '$' + '{' + varName + '}' + BT;
  }

  output.push(line);
}

// Add 'use strict' if not present.
if (!output[0].includes('use strict')) {
  output.unshift("'use strict';", '');
}

const result = output.join('\n');
fs.writeFileSync(path, result);

// Print summary to stdout so the host can verify execution.
const changes = [];
if (source.includes('var ')) changes.push('var -> const/let');
if (source.includes('function(') || source.includes('function (')) changes.push('function -> arrow');
if (source.match(/'[^']*'\s*\+/)) changes.push('concat -> template literal');
if (!source.includes('use strict')) changes.push('added use strict');
console.log('Codemod applied: ' + changes.join(', '));
`;

/** Print a minimal unified-style diff between two strings. */
function simpleDiff(original: string, transformed: string, filename: string): string {
  const oldLines = original.split("\n");
  const newLines = transformed.split("\n");
  const out: string[] = [`--- a/${filename}`, `+++ b/${filename}`];

  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i++;
      j++;
    } else if (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
      // New or changed line
      out.push(`+ ${newLines[j]}`);
      j++;
    } else {
      // Removed line
      out.push(`- ${oldLines[i]}`);
      i++;
    }
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  console.log("=== secure-exec Codemod Example ===\n");

  // Set up in-memory VFS — the sandbox cannot touch the host filesystem.
  const vfs = createInMemoryFileSystem();

  // Write the source file into the VFS so the sandbox can read it.
  await vfs.writeFile("/app/src/server.js", INPUT_SOURCE);

  // Create a sandboxed Node runtime with only filesystem permissions (no network,
  // no child_process, no env access). The codemod runs fully isolated.
  const driver = createNodeDriver({
    filesystem: vfs,
    permissions: { ...allowAllFs },
  });

  const runtime = new NodeRuntime({
    systemDriver: driver,
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  });

  try {
    // Execute the codemod inside the sandbox.
    console.log("Running codemod in sandbox...\n");
    const result = await runtime.exec(CODEMOD_SCRIPT, {
      cwd: "/app",
    });

    if (result.stdout) {
      console.log(`Sandbox output: ${result.stdout.trim()}\n`);
    }
    if (result.stderr) {
      console.error(`Sandbox errors: ${result.stderr.trim()}\n`);
    }

    // Read the transformed file back from VFS.
    const transformed = await vfs.readTextFile("/app/src/server.js");

    // Show the diff.
    console.log("--- Diff ---\n");
    console.log(simpleDiff(INPUT_SOURCE, transformed, "src/server.js"));
    console.log("\n--- Transformed Source ---\n");
    console.log(transformed);
  } finally {
    runtime.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Removes the previous test build.
//
// tsc does not clean its outDir, and the emitted layout shifts whenever the
// `include` list changes its common root. Without this, stale .test.js files
// from an older layout keep running and a renamed or deleted test appears to
// pass forever.
import { rmSync } from 'node:fs';

rmSync('dist-test', { recursive: true, force: true });

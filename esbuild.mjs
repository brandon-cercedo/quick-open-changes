// Bundles the extension and its dependencies into dist/extension.js, the file
// VS Code loads ("main" in package.json). tsc still type-checks and compiles
// the tests into out/.
//
//   node esbuild.mjs               development build, with source maps
//   node esbuild.mjs --watch       rebuild on every change (F5 build task)
//   node esbuild.mjs --production  minified, no source maps (vscode:prepublish)
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * In watch mode, prints the lines the problem matcher in .vscode/tasks.json
 * reads: when a build starts and ends, and each error with its location.
 */
const watchLogPlugin = {
  name: "watch-log",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
        }
      }
      console.log("[watch] build finished");
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node20",
  // Provided by VS Code at runtime.
  external: ["vscode"],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  // Watch mode prints its own errors in the problem matcher's format.
  logLevel: watch ? "silent" : "warning",
  plugins: watch ? [watchLogPlugin] : [],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}

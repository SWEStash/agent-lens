import { defineConfig } from "vitest/config";

// Tests run against each package's BUILT dist (the root `test` script builds first), so they
// exercise exactly what ships and avoid NodeNext .js-specifier resolution in source. packages/web is
// the exception — it has no dist to import, so its tests import source and need vite (and jsdom, for
// the hook/component ones). That package owns its own vitest.config.ts; this config just references
// it, so the whole-repo run and the package-local run execute the same projects.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/web/**"],
        },
      },
      "packages/web",
    ],
  },
});

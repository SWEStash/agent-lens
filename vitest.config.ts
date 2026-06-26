import { defineConfig } from "vitest/config";

// Tests run against each package's BUILT dist (the root `test` script builds first), so they
// exercise exactly what ships and avoid NodeNext .js-specifier resolution in source.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
  },
});

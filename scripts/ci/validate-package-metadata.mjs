import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

if (pkg.name !== "brinnpay") {
  console.error(`Expected package name "brinnpay", got "${pkg.name}"`);
  process.exit(1);
}

console.log("Package:", pkg.name, "Version:", pkg.version);
import { start } from "./index.js";

export { start, main } from "./index.js";

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

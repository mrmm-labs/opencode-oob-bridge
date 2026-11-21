import { spike } from "./spike-keychain.js"
const r = spike("oob-bridge-spike-test", "probe", "s3cret-value")
console.log(
  JSON.stringify({
    steps: r.steps,
    readBack: r.readBack,
    exec: r.exec,
    bun: r.bun,
  }),
)
if (process.argv[2] !== "keep") console.log("delete", r.cleanup())

#!/usr/bin/env node
import { main } from "../skills/agy-orch/scripts/runtime/cli.ts";

await main(process.argv.slice(2));

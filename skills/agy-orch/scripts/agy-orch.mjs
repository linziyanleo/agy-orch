#!/usr/bin/env node
import { main } from "./runtime/cli.ts";

await main(process.argv.slice(2));

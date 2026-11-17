#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv).catch((e: Error) => {
  console.error(`tracegate: ${e.message}`);
  process.exit(2);
});

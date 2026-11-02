#!/bin/bash
# EscrowPact contract build (near-sdk-js).
set -e
cd "$(dirname "$0")/.."
mkdir -p build
../node_modules/.bin/near-sdk-js build src/index.ts build/contract.wasm package.json tsconfig.json
ls -la build/contract.wasm

#!/bin/bash
cd /work && swift test --package-path ios/DsulCore --scratch-path /tmp/core-build "$@" 2>&1

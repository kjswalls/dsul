#!/bin/bash
cd /shim && swift test --scratch-path /tmp/shim-build "$@" 2>&1

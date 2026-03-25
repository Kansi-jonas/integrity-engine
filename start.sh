#!/bin/bash
set -e
echo "=== RTKdata Integrity Engine Starting ==="
exec npm start -- -p ${PORT:-3001}

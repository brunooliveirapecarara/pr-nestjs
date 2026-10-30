#!/bin/sh
set -e

node dist/database/migrate-up.js
exec node dist/main.js

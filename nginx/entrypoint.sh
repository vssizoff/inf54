#!/bin/sh
set -e

envsubst '${OIDC_CLIENT_ID} ${OIDC_REDIRECT_URI}' \
  < /config.js.template \
  > /frontend/config.js

exec nginx -g "daemon off;"